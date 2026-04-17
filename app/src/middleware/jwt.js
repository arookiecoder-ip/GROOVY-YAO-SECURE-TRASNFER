const { verifyAccessToken, rotateRefreshToken, getSession } = require('../services/auth');

const ACCESS_COOKIE  = 'access_token';
const REFRESH_COOKIE = 'refresh_token';

const PUBLIC_ROUTES = new Set([
  'GET:/api/health',
  'GET:/api/auth/session',
  'GET:/api/auth/first-run',
  'POST:/api/auth/webauthn/register/begin',
  'POST:/api/auth/webauthn/register/complete',
  'POST:/api/auth/webauthn/authenticate/begin',
  'POST:/api/auth/webauthn/authenticate/complete',
  'POST:/api/auth/totp/setup',
  'POST:/api/auth/totp/verify',
  'POST:/api/auth/password/set',
  'POST:/api/auth/password/login',
  'POST:/api/auth/combo/login',
]);

async function jwtMiddleware(req, reply) {
  const key = `${req.method}:${req.routeOptions?.url || req.url.split('?')[0]}`;

  // Allow static files and public API routes
  if (!req.url.startsWith('/api/') || PUBLIC_ROUTES.has(key)) return;

  // Routes that handle their own auth (e.g. download checks is_public)
  if (req.routeOptions?.config?.public) return;

  const token = req.cookies?.[ACCESS_COOKIE];

  if (token) {
    try {
      const sessionId = await verifyAccessToken(token);
      const session = getSession(sessionId);
      if (!session) return reply.code(401).send({ error: 'Session revoked' });
      req.sessionId = sessionId;
      return;
    } catch {
      // fall through to refresh attempt
    }
  }

  // Try refresh rotation
  const refresh = req.cookies?.[REFRESH_COOKIE];
  if (refresh) {
    try {
      const { accessToken, refreshToken } = await rotateRefreshToken(refresh, req.ip);
      const cookieOpts = {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      };
      reply
        .setCookie(ACCESS_COOKIE,  accessToken,  { ...cookieOpts, maxAge: 15 * 60 })
        .setCookie(REFRESH_COOKIE, refreshToken, { ...cookieOpts, maxAge: 7 * 24 * 60 * 60 });

      const sessionId = await verifyAccessToken(accessToken);
      req.sessionId = sessionId;
      return;
    } catch {
      // fall through to 401
    }
  }

  return reply.code(401).send({ error: 'Unauthorized' });
}

module.exports = jwtMiddleware;
