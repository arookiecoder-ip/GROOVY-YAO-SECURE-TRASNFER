const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/db');
const { config } = require('../config');
const {
  createSession,
  rotateRefreshToken,
  revokeSession,
  hasAnyCredential,
} = require('../services/auth');
const {
  encryptTotpSecret,
  decryptTotpSecret,
} = require('../services/encryption');

const RP_NAME = 'Groovy YAO';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';

const COOKIE_OPTS_BASE = {
  httpOnly: true,
  sameSite: 'strict',
  path: '/',
};

function cookieOpts(maxAgeMs) {
  return {
    ...COOKIE_OPTS_BASE,
    secure: config.nodeEnv === 'production',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

function rpID() {
  try { return new URL(config.domain).hostname; } catch { return 'localhost'; }
}

function origin() { return config.domain; }

function storeChallenge(db, challenge, type) {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO auth_challenges (id, challenge, type, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(id, challenge, type, Date.now() + CHALLENGE_TTL_MS);
  return id;
}

function consumeChallenge(db, challenge, type) {
  const row = db.prepare(`
    SELECT * FROM auth_challenges
    WHERE challenge = ? AND type = ? AND used = 0 AND expires_at > ?
  `).get(challenge, type, Date.now());
  if (!row) return false;
  db.prepare('UPDATE auth_challenges SET used = 1 WHERE id = ?').run(row.id);
  return true;
}

function setTokenCookies(reply, accessToken, refreshToken) {
  reply
    .setCookie(ACCESS_COOKIE,  accessToken,  cookieOpts(15 * 60 * 1000))
    .setCookie(REFRESH_COOKIE, refreshToken, cookieOpts(7 * 24 * 60 * 60 * 1000));
}

async function authRoutes(fastify) {

  // ── Session check ──────────────────────────────────────────────────────────
  fastify.get('/session', { config: { noAuth: true } }, async (req, reply) => {
    const token = req.cookies[ACCESS_COOKIE];
    if (!token) return reply.code(401).send({ error: 'No session' });
    try {
      const { verifyAccessToken, getSession } = require('../services/auth');
      const sessionId = await verifyAccessToken(token);
      const session = getSession(sessionId);
      if (!session) return reply.code(401).send({ error: 'Session revoked' });
      return reply.send({ ok: true, authMethod: session.auth_method });
    } catch {
      // Try refresh rotation
      const refresh = req.cookies[REFRESH_COOKIE];
      if (!refresh) return reply.code(401).send({ error: 'Token expired' });
      try {
        const { accessToken, refreshToken } = await rotateRefreshToken(refresh, req.ip);
        setTokenCookies(reply, accessToken, refreshToken);
        return reply.send({ ok: true });
      } catch {
        return reply.code(401).send({ error: 'Session expired' });
      }
    }
  });

  // ── First-run check ────────────────────────────────────────────────────────
  fastify.get('/first-run', { config: { noAuth: true } }, async (_req, reply) => {
    return reply.send({ firstRun: !hasAnyCredential() });
  });

  // ── Logout ─────────────────────────────────────────────────────────────────
  fastify.post('/logout', async (req, reply) => {
    if (req.sessionId) revokeSession(req.sessionId);
    reply
      .clearCookie(ACCESS_COOKIE,  { path: '/' })
      .clearCookie(REFRESH_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // WebAuthn
  // ══════════════════════════════════════════════════════════════════════════

  fastify.post('/webauthn/register/begin', { config: { noAuth: true } }, async (_req, reply) => {
    const db = getDb();
    const existing = db.prepare('SELECT id, transports FROM webauthn_credentials').all();

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpID(),
      userID: Buffer.from('single-user'),
      userName: 'operator',
      userDisplayName: 'Operator',
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        transports: JSON.parse(c.transports || '[]'),
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    storeChallenge(db, options.challenge, 'registration');
    return reply.send(options);
  });

  fastify.post('/webauthn/register/complete', { config: { noAuth: true } }, async (req, reply) => {
    const db = getDb();
    const body = req.body;

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: (c) => consumeChallenge(db, c, 'registration'),
        expectedOrigin: origin(),
        expectedRPID: rpID(),
      });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }

    if (!verification.verified || !verification.registrationInfo) {
      return reply.code(400).send({ error: 'Verification failed' });
    }

    const { credential } = verification.registrationInfo;
    const now = Date.now();

    db.prepare(`
      INSERT INTO webauthn_credentials (id, public_key, counter, device_type, transports, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      verification.registrationInfo.credentialDeviceType || null,
      JSON.stringify(body.response?.transports || []),
      now,
    );

    const { accessToken, refreshToken } = await createSession('webauthn', req.ip);
    setTokenCookies(reply, accessToken, refreshToken);
    return reply.send({ ok: true });
  });

  fastify.post('/webauthn/authenticate/begin', { config: { noAuth: true } }, async (_req, reply) => {
    const db = getDb();
    const credentials = db.prepare('SELECT id, transports FROM webauthn_credentials').all();

    if (credentials.length === 0) {
      return reply.code(400).send({ error: 'No passkeys registered' });
    }

    const options = await generateAuthenticationOptions({
      rpID: rpID(),
      userVerification: 'preferred',
      allowCredentials: credentials.map((c) => ({
        id: c.id,
        transports: JSON.parse(c.transports || '[]'),
      })),
    });

    storeChallenge(db, options.challenge, 'authentication');
    return reply.send(options);
  });

  fastify.post('/webauthn/authenticate/complete', { config: { noAuth: true } }, async (req, reply) => {
    const db = getDb();
    const body = req.body;

    const credential = db.prepare('SELECT * FROM webauthn_credentials WHERE id = ?').get(body.id);
    if (!credential) return reply.code(400).send({ error: 'Unknown credential' });

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: (c) => consumeChallenge(db, c, 'authentication'),
        expectedOrigin: origin(),
        expectedRPID: rpID(),
        credential: {
          id: credential.id,
          publicKey: new Uint8Array(credential.public_key),
          counter: credential.counter,
          transports: JSON.parse(credential.transports || '[]'),
        },
      });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }

    if (!verification.verified) {
      return reply.code(401).send({ error: 'Authentication failed' });
    }

    db.prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(verification.authenticationInfo.newCounter, Date.now(), credential.id);

    const { accessToken, refreshToken } = await createSession('webauthn', req.ip);
    setTokenCookies(reply, accessToken, refreshToken);
    return reply.send({ ok: true });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TOTP
  // ══════════════════════════════════════════════════════════════════════════

  fastify.post('/totp/setup', { config: { noAuth: true } }, async (_req, reply) => {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM totp_config WHERE id = 1').get();
    if (existing) return reply.code(409).send({ error: 'TOTP already configured' });

    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri('operator', RP_NAME, secret);
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl);

    // Store encrypted but not yet enabled — enabled on first successful verify
    const { ciphertext, iv, tag } = encryptTotpSecret(secret);
    db.prepare(`
      INSERT INTO totp_config (id, secret, enabled, created_at)
      VALUES (1, ?, 0, ?)
    `).run(JSON.stringify({ ciphertext, iv, tag }), Date.now());

    return reply.send({ qrDataUrl, otpauthUrl });
  });

  fastify.post('/totp/verify', {
    config: { noAuth: true },
    config: {
      noAuth: true,
      rateLimit: { max: 5, timeWindow: '10 minutes' },
    },
  }, async (req, reply) => {
    const db = getDb();
    const { token } = req.body || {};
    if (!token || !/^\d{6,8}$/.test(token)) {
      return reply.code(400).send({ error: 'Invalid token format' });
    }

    const row = db.prepare('SELECT * FROM totp_config WHERE id = 1').get();
    if (!row) return reply.code(400).send({ error: 'TOTP not configured' });

    const enc = JSON.parse(row.secret);
    const secret = decryptTotpSecret(enc.ciphertext, enc.iv, enc.tag);

    authenticator.options = { window: 1 };
    const valid = authenticator.verify({ token, secret });

    if (!valid) {
      // Also check backup codes
      const backupCodes = row.backup_codes ? JSON.parse(row.backup_codes) : [];
      const codeHash = crypto.createHash('sha256').update(token).digest('hex');
      const matchIdx = backupCodes.findIndex((h) => h === codeHash);
      if (matchIdx === -1) return reply.code(401).send({ error: 'Invalid code' });

      // Consume backup code
      backupCodes.splice(matchIdx, 1);
      db.prepare('UPDATE totp_config SET backup_codes = ?, last_used_at = ? WHERE id = 1')
        .run(JSON.stringify(backupCodes), Date.now());
    } else {
      db.prepare('UPDATE totp_config SET enabled = 1, last_used_at = ? WHERE id = 1').run(Date.now());
    }

    const { accessToken, refreshToken } = await createSession('totp', req.ip);
    setTokenCookies(reply, accessToken, refreshToken);
    return reply.send({ ok: true });
  });

  // Generate backup codes (call after TOTP is enabled)
  fastify.post('/totp/backup-codes', async (_req, reply) => {
    const db = getDb();
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex'));
    const hashes = codes.map((c) => crypto.createHash('sha256').update(c).digest('hex'));
    db.prepare('UPDATE totp_config SET backup_codes = ? WHERE id = 1').run(JSON.stringify(hashes));
    return reply.send({ codes });
  });
}

module.exports = authRoutes;
