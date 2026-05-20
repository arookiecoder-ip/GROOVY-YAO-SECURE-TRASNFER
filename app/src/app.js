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
  } catch (_e) {
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

    // Wildcard catch-all under /s/:token/* — strip extra path and redirect to canonical
    f.get('/s/:token/*', { config: { public: true } }, async (req, reply) => {
      return reply.redirect(301, `/s/${req.params.token}`);
    });

    // Wildcard catch-all under /b/:token/* — strip extra path and redirect to canonical
    f.get('/b/:token/*', { config: { public: true } }, async (req, reply) => {
      return reply.redirect(301, `/b/${req.params.token}`);
    });
  });

  // WebSocket route
  const { wsRoutes } = require('./routes/ws');
  await fastify.register(wsRoutes);

  // Expiry watcher
  const { startExpiryWatcher } = require('./services/expiry');
  startExpiryWatcher();

  // Global Error Handler to squelch internal leaks
  fastify.setErrorHandler((error, request, reply) => {
    if (error.statusCode && error.statusCode < 500) {
      const isBrowser = (request.headers['accept'] || '').includes('text/html');
      if (isBrowser) {
        return reply.code(error.statusCode).type('text/html').send(
          _errorPage(error.statusCode, error.statusCode === 404 ? 'Page Not Found' : 'Client Error',
            error.statusCode === 404
              ? `The page <code>${_esc(request.url)}</code> does not exist.`
              : error.message || 'Something went wrong.')
        );
      }
      return reply.code(error.statusCode).send({ error: error.message || 'Client Error' });
    }
    request.log.error(error);
    const isBrowser = (request.headers['accept'] || '').includes('text/html');
    if (isBrowser) {
      return reply.code(500).type('text/html').send(
        _errorPage(500, 'Internal Server Error', 'Something went wrong on our end. Please try again.')
      );
    }
    reply.code(500).send({ error: 'Internal Server Error' });
  });

  // Global 404 handler — catches all unmatched routes
  fastify.setNotFoundHandler((request, reply) => {
    const isBrowser = (request.headers['accept'] || '').includes('text/html');

    // Smart redirect: if URL looks like /s/<token>/anything or /b/<token>/anything,
    // strip the extra path and redirect to the canonical short URL
    const shareMatch = request.url.match(/^\/s\/([^/?#]+)/);
    const bundleMatch = request.url.match(/^\/b\/([^/?#]+)/);
    if (shareMatch) return reply.redirect(301, `/s/${shareMatch[1]}`);
    if (bundleMatch) return reply.redirect(301, `/b/${bundleMatch[1]}`);

    if (isBrowser) {
      return reply.code(404).type('text/html').send(
        _errorPage(404, 'Page Not Found',
          `The page <code>${_esc(request.url)}</code> does not exist.`)
      );
    }
    reply.code(404).send({ error: 'Not Found', url: request.url });
  });

  return fastify;
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _errorPage(code, title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>GROOVY YAO // ${_esc(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#050a0e;color:#00f5ff;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{border:1px solid #00f5ff33;padding:48px 40px;max-width:480px;width:100%;text-align:center}
    .code{font-size:4rem;font-weight:700;color:#00f5ff22;letter-spacing:.1em;margin-bottom:8px}
    .title{font-size:1rem;font-weight:700;letter-spacing:.15em;color:#ff4444;margin-bottom:24px}
    .msg{font-size:.85rem;color:#aaa;line-height:1.7;margin-bottom:32px}
    code{background:#0a1520;padding:2px 8px;border:1px solid #00f5ff22;font-size:.8rem;color:#00f5ff;word-break:break-all}
    .btn{display:inline-block;padding:10px 28px;border:1px solid #00f5ff;color:#00f5ff;text-decoration:none;font-family:inherit;font-size:.8rem;letter-spacing:.1em;transition:background .15s,color .15s}
    .btn:hover{background:#00f5ff;color:#000}
    .brand{font-size:.68rem;letter-spacing:.2em;color:#00f5ff44;margin-bottom:32px}
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">GROOVY YAO // SECURE FILE TRANSFER</div>
    <div class="code">${code}</div>
    <div class="title">// ${_esc(title).toUpperCase()}</div>
    <div class="msg">${message}</div>
    <a href="/" class="btn">RETURN TO BASE</a>
  </div>
</body>
</html>`;
}

module.exports = { buildApp };
