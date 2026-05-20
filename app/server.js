require('dotenv').config();

const { validateEnv, config } = require('./src/config');
validateEnv();

const path = require('path');
const fs = require('fs');
const { closeDb } = require('./src/db/db');

// Fix #19: recursive: true already handles existing dirs — no need for existsSync
for (const dir of [config.storagePath, config.chunksPath, path.dirname(config.dbPath)]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Run migrations
require('./src/db/migrate');

const { buildApp } = require('./src/app');

async function start() {
  const app = await buildApp();

  // Fix #21: close DB cleanly on process exit so WAL checkpoints flush
  const shutdown = (signal) => {
    app.log.info(`Received ${signal}, shutting down`);
    app.close(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  try {
    // Fix #18: listen on 0.0.0.0 and log the actual bound address
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`Groovy YAO listening on 0.0.0.0:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
