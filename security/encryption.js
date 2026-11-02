'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function getMasterKey() {
  const encoded = process.env.BITOPRO_MASTER_KEY || '';
  if (!encoded) throw new Error('BITOPRO_MASTER_KEY is not configured');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('BITOPRO_MASTER_KEY must be a Base64-encoded 32-byte key');
  return key;
}

function generateMasterKey() {
  return crypto.randomBytes(32).toString('base64');
}

function encryptString(plainText) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptString(payload) {
  if (!payload || payload.version !== 1 || payload.algorithm !== ALGORITHM) {
    throw new Error('Unsupported encrypted payload');
  }
  const key = getMasterKey();
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const encrypted = Buffer.from(payload.data, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Invalid encrypted payload');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { generateMasterKey, encryptString, decryptString };
