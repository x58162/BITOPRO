'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

class SessionStore {
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
    this.sessions = new Map();
  }

  create(metadata = {}) {
    const id = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(id, {
      id,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      tradeUnlockedUntil: 0,
      metadata: { ...metadata }
    });
    return { id, expiresAt: now + this.ttlMs };
  }

  get(id) {
    if (!id) return null;
    const session = this.sessions.get(String(id));
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(String(id));
      return null;
    }
    return session;
  }

  destroy(id) {
    return this.sessions.delete(String(id));
  }

  destroyAll() {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }
}

module.exports = { SessionStore };
