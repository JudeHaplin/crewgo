'use strict';
/**
 * 本地账号：姓名 + PIN。令牌 = 载荷 + HMAC 签名，密钥首次启动自动生成。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./store');

let cachedSecret = null;

function getSecret() {
  if (cachedSecret) return cachedSecret;
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v) { cachedSecret = v; return v; }
  } catch (e) { /* 首次启动还没有 */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  cachedSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, cachedSecret, { mode: 0o600 });
  return cachedSecret;
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return 's1$' + salt + '$' + h;
}

function verifyPin(pin, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3) return false;
  const h = crypto.scryptSync(String(pin), parts[1], 32);
  const want = Buffer.from(parts[2], 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return body + '.' + mac;
}

function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const idx = token.lastIndexOf('.');
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  if (mac.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

const issue = profile => sign({ pid: profile.id, exp: Date.now() + 1000 * 60 * 60 * 24 * 90 });

module.exports = { hashPin, verifyPin, sign, verify, issue };
