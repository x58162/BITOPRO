'use strict';

const DEFAULT_UNLOCK_MS = 10 * 60 * 1000;

function unlockSession(session, durationMs = DEFAULT_UNLOCK_MS) {
  if (!session || !Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('A valid session and positive unlock duration are required');
  }
  session.tradeUnlockedUntil = Date.now() + durationMs;
  return session.tradeUnlockedUntil;
}

function lockSession(session) {
  if (session) session.tradeUnlockedUntil = 0;
}

function isTradeUnlocked(session, now = Date.now()) {
  return !!session && Number.isFinite(session.tradeUnlockedUntil) && session.tradeUnlockedUntil > now;
}

function requireTradeUnlock(session) {
  if (!isTradeUnlocked(session)) {
    const error = new Error('交易功能尚未解鎖或授權已逾期');
    error.code = 'TRADE_LOCKED';
    throw error;
  }
  return true;
}

module.exports = {
  DEFAULT_UNLOCK_MS,
  unlockSession,
  lockSession,
  isTradeUnlocked,
  requireTradeUnlock
};
