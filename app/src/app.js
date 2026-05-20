const fastify = require('fastify')({ logger: true, bodyLimit: 70 * 1024 * 1024, ignoreTrailingSlash: true });
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');

// ── CSRF helpers ─────────────────────────────────────────────────────────────
// Fix #4: implement double-submit cookie CSRF protection.
// A signed CSRF token is issued as a readable cookie; the client must echo it
// back in the X-CSRF-Token header on every state-mutating request.
const CSRF_COOKIE = 'csrf_token';
const CSRF_HEADER = 'x-csrf-token';

// State-mutating methods that require CSRF validation
const CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Routes exempt from CSRF (public upload endpoints use token-based auth instead)
const CSRF_EXEMPT = new Set([
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

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function signCsrfToken(token) {
  return crypto
    .createHmac('sha256', Buffer.from(config.csrfSecret, 'hex'))
    .update(token)
    .digest('hex');
}

function verifyCsrfToken(token, sig) {
  if (!token || !sig) return false;
  const expected = signCsrfToken(token);
  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

async function buildApp() {
  // Security headers
  await fastify.register(require('@fastify/helmet'), {
    contentSecurityPolicy: config.nodeEnv === 'production' ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", config.domain ? config.domain.replace('https://', 'wss://') : 'wss://localhost'],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: [],
      },
    } : false,
    hsts: config.nodeEnv === 'production' ? {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    } : false,
    frameguard: { action: 'deny' },
    noSniff: true,
    xssFilter: true,
  });

  // Fix #9: only trust cf-connecting-ip (Cloudflare) or fall back to req.ip.
  // Never trust x-forwarded-for directly — it can be spoofed by clients.
  await fastify.register(require('@fastify/rate-limit'), {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.ip,
    onExceeded: (req, key) => {
      req.log.warn({ event: 'TRAFFIC_ANOMALY', ip: key, url: req.raw.url }, 'Rate limit exceeded');
    }
  });

  // Cookies
  await fastify.register(require('@fastify/cookie'), {
    secret: config.csrfSecret,
    parseOptions: {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'strict',
    },
  });

  // Multipart (file uploads)
  await fastify.register(require('@fastify/multipart'), {
    limits: {
      fileSize: config.maxFileSizeMb * 1024 * 1024,
      files: 20,
    },
  });

  // Static files
  await fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, '../frontend'),
    prefix: '/',
  });

  // WebSocket
  await fastify.register(require('@fastify/websocket'));

  // HTTPS enforcement (Production)
  if (config.nodeEnv === 'production') {
    fastify.addHook('onRequest', async (req, reply) => {
      const proto = req.headers['x-forwarded-proto'];
      if (proto && proto !== 'https') {
        return reply.redirect(301, `https://${req.headers.host}${req.raw.url}`);
      }
    });
  }

  // Fix #4: Issue CSRF token cookie on every response if not already set.
  // The cookie is NOT httpOnly so the frontend JS can read it and echo it back
  // in the X-CSRF-Token header.
  fastify.addHook('onRequest', async (req, reply) => {
    if (!req.cookies?.[CSRF_COOKIE]) {
      const token = generateCsrfToken();
      const sig = signCsrfToken(token);
      // Store token:sig in the cookie so we can verify without server-side state
      reply.setCookie(CSRF_COOKIE, `${token}.${sig}`, {
        httpOnly: false, // must be readable by JS
        sameSite: 'strict',
        path: '/',
        secure: config.nodeEnv === 'production',
        maxAge: 24 * 60 * 60, // 1 day
      });
    }
  });

  // Fix #4: Validate CSRF token on state-mutating API requests
  fastify.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (!CSRF_METHODS.has(req.method)) return;

    const routeKey = `${req.method}:${req.routeOptions?.url || req.url.split('?')[0]}`;

    // Skip public auth endpoints and public upload endpoints
    if (CSRF_EXEMPT.has(routeKey)) return;
    if (req.routeOptions?.config?.public) return;

    const cookieVal = req.cookies?.[CSRF_COOKIE];
    const headerVal = req.headers[CSRF_HEADER];

    if (!cookieVal || !headerVal) {
      return reply.code(403).send({ error: 'CSRF token missing' });
    }

    const [token, sig] = cookieVal.split('.');
    if (!verifyCsrfToken(token, sig) || token !== headerVal) {
      req.log.warn({ event: 'CSRF_FAILURE', url: req.url }, 'CSRF validation failed');
      return reply.code(403).send({ error: 'CSRF token invalid' });
    }
  });

  // JWT auth hook — runs before every request
  fastify.addHook('onRequest', require('./middleware/jwt'));

  // Routes
  await fastify.register(require('./routes/health'), { prefix: '/api' });
  await fastify.register(require('./routes/auth'),   { prefix: '/api/auth' });
  await fastify.register(require('./routes/files'),  { prefix: '/api' });
  await fastify.register(require('./routes/chunks'), { prefix: '/api' });
  await fastify.register(require('./routes/uploadRequests'), { prefix: '/api' });
  await fastify.register(require('./routes/bundles'),        { prefix: '/api' });

  // ── Short public share links (no /api prefix) ─────────────────────────────
  // /s/:token  → single file share page
  // /b/:token  → bundle page
  await fastify.register(async function shortLinks(f) {
    const { filesShortRoute } = require('./routes/files');
    const { bundlesShortRoute } = require('./routes/bundles');
    if (filesShortRoute) await filesShortRoute(f);
    if (bundlesShortRoute) await bundlesShortRoute(f);
  });

  // WebSocket route
  const { wsRoutes } = require('./routes/ws');
  await fastify.register(wsRoutes);

  // Expiry watcher
  const { startExpiryWatcher } = require('./services/expiry');
  startExpiryWatcher();

  // Global Error Handler to squelch internal leaks
  fastify.setErrorHandler((error, request, reply) => {
    // If it's a Fastify-internal validation or rate limit error, keep it standard
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: error.message || 'Client Error'
      });
    }

    // Log full error, stack trace, and potentially DB constraints server-side ONLY
    request.log.error(error);

    // Send generic client message
    reply.code(500).send({ error: 'Internal Server Error' });
  });

  return fastify;
}

module.exports = { buildApp };
