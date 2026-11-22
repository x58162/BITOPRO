'use strict';

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const CODE_DIGITS = 6;

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(input) {
  const normalized = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid Base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateSecret(bytes = 20) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 64) {
    throw new RangeError('Authenticator secret length must be between 16 and 64 bytes');
  }
  return encodeBase32(crypto.randomBytes(bytes));
}

function generateCode(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / STEP_SECONDS);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % (10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

function verifyCode(secret, token, options = {}) {
  const window = Number.isInteger(options.window) ? Math.max(0, Math.min(options.window, 2)) : 1;
  const supplied = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(supplied)) return false;
  const now = Number.isFinite(options.timestamp) ? options.timestamp : Date.now();
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = generateCode(secret, now + drift * STEP_SECONDS * 1000);
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function createOtpAuthUrl(secret, accountName, issuer = 'BITOPRO') {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(CODE_DIGITS),
    period: String(STEP_SECONDS)
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

module.exports = {
  generateSecret,
  generateCode,
  verifyCode,
  createOtpAuthUrl
};
