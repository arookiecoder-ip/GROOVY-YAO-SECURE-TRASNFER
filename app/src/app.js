const fastify = require('fastify')({ logger: true });
const path = require('path');
const { config } = require('./config');

async function buildApp() {
  // Security headers
  await fastify.register(require('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", config.domain ? config.domain.replace('https://', 'wss://') : 'wss://localhost'],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    xssFilter: true,
  });

  // Rate limiting
  await fastify.register(require('@fastify/rate-limit'), {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.ip,
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

  // JWT auth hook — runs before every request
  fastify.addHook('onRequest', require('./middleware/jwt'));

  // Routes
  await fastify.register(require('./routes/health'), { prefix: '/api' });
  await fastify.register(require('./routes/auth'),   { prefix: '/api/auth' });
  await fastify.register(require('./routes/files'),  { prefix: '/api' });
  await fastify.register(require('./routes/chunks'), { prefix: '/api' });

  // Expiry watcher
  const { startExpiryWatcher } = require('./services/expiry');
  startExpiryWatcher();

  return fastify;
}

module.exports = { buildApp };
