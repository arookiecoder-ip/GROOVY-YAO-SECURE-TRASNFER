const crypto = require('crypto');
const { SignJWT, jwtVerify } = require('jose');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/db');
const { config } = require('../config');

const ACCESS_TTL_MS  = 15 * 60 * 1000;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function jwtKey() {
  return Buffer.from(config.jwtSecret, 'hex');
}

function hashIp(ip) {
  return crypto.createHmac('sha256', Buffer.from(config.ipHmacKey, 'hex')).update(ip || '').digest('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── JWT ──────────────────────────────────────────────────────────────────────

async function issueAccessToken(sessionId) {
  return new SignJWT({ sub: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + ACCESS_TTL_MS) / 1000))
    .sign(jwtKey());
}

async function verifyAccessToken(token) {
  const { payload } = await jwtVerify(token, jwtKey(), { algorithms: ['HS256'] });
  return payload.sub;
}

// ── Sessions ─────────────────────────────────────────────────────────────────

async function createSession(authMethod, ip) {
  const db = getDb();
  const id = uuidv4();
  const rawRefresh = crypto.randomBytes(48).toString('hex');
  const now = Date.now();

  db.prepare(`
    INSERT INTO sessions (id, refresh_token, auth_method, created_at, expires_at, last_seen_at, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, hashToken(rawRefresh), authMethod, now, now + REFRESH_TTL_MS, now, hashIp(ip));

  const access = await issueAccessToken(id);
  return { accessToken: access, refreshToken: rawRefresh, sessionId: id };
}

async function rotateRefreshToken(rawRefresh, ip) {
  const db = getDb();
  const hashed = hashToken(rawRefresh);
  const session = db.prepare('SELECT * FROM sessions WHERE refresh_token = ? AND revoked = 0').get(hashed);

  if (!session) throw new Error('Invalid refresh token');
  if (Date.now() > session.expires_at) throw new Error('Refresh token expired');

  const newRaw = crypto.randomBytes(48).toString('hex');
  const now = Date.now();

  db.prepare(`
    UPDATE sessions SET refresh_token = ?, last_seen_at = ?, ip_hash = ? WHERE id = ?
  `).run(hashToken(newRaw), now, hashIp(ip), session.id);

  const access = await issueAccessToken(session.id);
  return { accessToken: access, refreshToken: newRaw };
}

function revokeSession(sessionId) {
  getDb().prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(sessionId);
}

function getSession(sessionId) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ? AND revoked = 0 AND expires_at > ?').get(sessionId, Date.now());
}

// ── Credentials check ─────────────────────────────────────────────────────────

function hasAnyCredential() {
  const db = getDb();
  const wc = db.prepare('SELECT COUNT(*) as n FROM webauthn_credentials').get();
  const tc = db.prepare('SELECT COUNT(*) as n FROM totp_config WHERE enabled = 1').get();
  const pc = db.prepare('SELECT COUNT(*) as n FROM password_config').get();
  return wc.n > 0 || tc.n > 0 || pc.n > 0;
}

module.exports = {
  issueAccessToken,
  verifyAccessToken,
  createSession,
  rotateRefreshToken,
  revokeSession,
  getSession,
  hasAnyCredential,
  hashIp,
};
