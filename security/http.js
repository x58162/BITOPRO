'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const authenticator = require('./authenticator');
const { SessionStore } = require('./session');
const { unlockSession, lockSession, isTradeUnlocked } = require('./trade-guard');

const router = express.Router();
const dataDir = path.join(__dirname, '..', 'data');
const stateFile = path.join(dataDir, 'security.json');
const keyFile = path.join(dataDir, 'master.key');
const COOKIE = 'bitopro_sid';
const sessions = new SessionStore({ ttlMs: 12 * 60 * 60 * 1000 });
const attempts = new Map();

fs.mkdirSync(dataDir, { recursive: true });
function getKey() {
  if (!fs.existsSync(keyFile)) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(keyFile, 0o600); } catch {}
  }
  const key = fs.readFileSync(keyFile);
  if (key.length !== 32) throw new Error('data/master.key 格式錯誤');
  return key;
}
function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decryptSecret(record) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
}
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}
function writeState(value) {
  const temp = stateFile + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, stateFile);
}
function isLoopback(req) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}
function clientSession(req) {
  const raw = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
  return raw ? sessions.get(decodeURIComponent(raw.slice(COOKIE.length + 1))) : null;
}
function setCookie(res, id) {
  res.setHeader('Set-Cookie', COOKIE + '=' + encodeURIComponent(id) + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200');
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', COOKIE + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}
function limited(req) {
  const key = String(req.socket.remoteAddress || 'local');
  const now = Date.now();
  const row = attempts.get(key) || { count: 0, until: now + 60000 };
  if (now > row.until) { row.count = 0; row.until = now + 60000; }
  row.count += 1; attempts.set(key, row);
  return row.count > 10;
}

router.get('/status', (req, res) => {
  const configured = !!readState().secret;
  const session = clientSession(req);
  res.json({ configured, authenticated: !!session, tradeUnlocked: isTradeUnlocked(session), tradeUnlockRemainingMs: session ? Math.max(0, session.tradeUnlockedUntil - Date.now()) : 0 });
});

router.post('/setup/start', async (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: '首次綁定只允許本機操作' });
  if (readState().secret) return res.status(409).json({ error: 'Authenticator 已綁定；不會再次顯示 QR Code' });
  if (limited(req)) return res.status(429).json({ error: '操作太頻繁，請稍後再試' });
  const secret = authenticator.generateSecret();
  const uri = authenticator.createOtpAuthUrl(secret, 'local-owner@bitopro', 'BITOPRO');
  const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 260 });
  req.app.locals.pendingAuthenticator = { secret, expiresAt: Date.now() + 5 * 60 * 1000 };
  res.json({ qr, expiresInMs: 300000, manualEntryKey: secret });
});

router.post('/setup/confirm', (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ error: '首次綁定只允許本機操作' });
  if (readState().secret) return res.status(409).json({ error: '已完成綁定' });
  const pending = req.app.locals.pendingAuthenticator;
  if (!pending || pending.expiresAt < Date.now()) return res.status(410).json({ error: 'QR Code 已逾時，請重新產生' });
  if (!authenticator.verifyCode(pending.secret, req.body?.code)) return res.status(400).json({ error: '驗證碼錯誤' });
  writeState({ version: 1, secret: encryptSecret(pending.secret), createdAt: new Date().toISOString() });
  delete req.app.locals.pendingAuthenticator;
  const session = sessions.create({ local: true });
  setCookie(res, session.id);
  res.json({ ok: true, message: 'Authenticator 綁定完成' });
});

router.post('/login', (req, res) => {
  if (limited(req)) return res.status(429).json({ error: '驗證次數過多，請稍後再試' });
  const saved = readState();
  if (!saved.secret) return res.status(409).json({ error: '尚未綁定 Authenticator' });
  let secret;
  try { secret = decryptSecret(saved.secret); } catch { return res.status(500).json({ error: '本機加密金鑰遺失或損壞，無法解密驗證器資料' }); }
  if (!authenticator.verifyCode(secret, req.body?.code)) return res.status(401).json({ error: '驗證碼錯誤' });
  const session = sessions.create({ local: true });
  setCookie(res, session.id);
  res.json({ ok: true });
});

router.post('/trade-unlock', (req, res) => {
  const session = clientSession(req);
  if (!session) return res.status(401).json({ error: '請先登入' });
  const saved = readState();
  if (!saved.secret) return res.status(409).json({ error: '尚未綁定 Authenticator' });
  let secret;
  try { secret = decryptSecret(saved.secret); } catch { return res.status(500).json({ error: '無法讀取驗證器資料' }); }
  if (!authenticator.verifyCode(secret, req.body?.code)) return res.status(401).json({ error: '驗證碼錯誤' });
  const until = unlockSession(session, 10 * 60 * 1000);
  res.json({ ok: true, tradeUnlockedUntil: until });
});

router.post('/logout', (req, res) => {
  const session = clientSession(req);
  if (session) sessions.destroy(session.id);
  clearCookie(res);
  res.json({ ok: true });
});

function requireLogin(req, res, next) {
  const session = clientSession(req);
  if (!session) return res.status(401).json({ ok: false, error: '請先使用 Authenticator 登入', code: 'AUTH_REQUIRED' });
  req.authSession = session;
  next();
}
function requireTrade(req, res, next) {
  const session = clientSession(req);
  if (!session) return res.status(401).json({ ok: false, error: '請先登入', code: 'AUTH_REQUIRED' });
  if (!isTradeUnlocked(session)) return res.status(423).json({ ok: false, error: '交易功能已鎖定，請重新輸入 Authenticator 驗證碼解鎖 10 分鐘', code: 'TRADE_LOCKED' });
  req.authSession = session;
  next();
}
function apiGate(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/api/security/')) return next();
  if (req.path === '/api/stop') return requireLogin(req, res, next);
  if (req.path === '/api/orders' && req.method === 'POST') return requireTrade(req, res, next);
  if (req.path.startsWith('/api/orders/') && ['PUT', 'DELETE'].includes(req.method)) return requireTrade(req, res, next);
  if (req.path === '/api/start' && req.method === 'POST') return requireTrade(req, res, next);
  return requireLogin(req, res, next);
}

module.exports = { router, apiGate, requireLogin, requireTrade, sessions };
