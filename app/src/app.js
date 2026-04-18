const fastify = require('fastify')({ logger: true, bodyLimit: 70 * 1024 * 1024 });
const path = require('path');
const { config } = require('./config');

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

  // Rate limiting (with structured anomaly logging)
  await fastify.register(require('@fastify/rate-limit'), {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip,
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

  // JWT auth hook — runs before every request
  fastify.addHook('onRequest', require('./middleware/jwt'));

  // Routes
  await fastify.register(require('./routes/health'), { prefix: '/api' });
  await fastify.register(require('./routes/auth'),   { prefix: '/api/auth' });
  await fastify.register(require('./routes/files'),  { prefix: '/api' });
  await fastify.register(require('./routes/chunks'), { prefix: '/api' });
  await fastify.register(require('./routes/uploadRequests'), { prefix: '/api' });

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
