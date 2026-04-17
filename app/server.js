require('dotenv').config();

const { validateEnv, config } = require('./src/config');
validateEnv();

const path = require('path');
const fs = require('fs');

// Ensure storage dirs exist
for (const dir of [config.storagePath, config.chunksPath, path.dirname(config.dbPath)]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Run migrations
require('./src/db/migrate');

const { buildApp } = require('./src/app');

async function start() {
  const app = await buildApp();

  try {
    await app.listen({ port: config.port, host: '127.0.0.1' });
    app.log.info(`Groovy YAO listening on 127.0.0.1:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
