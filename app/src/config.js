const REQUIRED = [
  'MASTER_SECRET',
  'JWT_SECRET',
  'CSRF_SECRET',
  'IP_HMAC_KEY',
  'DOMAIN',
  'STORAGE_PATH',
  'CHUNKS_PATH',
  'DB_PATH',
];

const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX32 = /^[0-9a-fA-F]{32}$/;

function validateEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[FATAL] Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!HEX64.test(process.env.MASTER_SECRET)) {
    console.error('[FATAL] MASTER_SECRET must be 64 hex chars');
    process.exit(1);
  }
  if (!HEX64.test(process.env.JWT_SECRET)) {
    console.error('[FATAL] JWT_SECRET must be 64 hex chars');
    process.exit(1);
  }
  if (!HEX32.test(process.env.CSRF_SECRET)) {
    console.error('[FATAL] CSRF_SECRET must be 32 hex chars');
    process.exit(1);
  }
  if (!HEX32.test(process.env.IP_HMAC_KEY)) {
    console.error('[FATAL] IP_HMAC_KEY must be 32 hex chars');
    process.exit(1);
  }
}

module.exports = {
  validateEnv,
  config: {
    get port() { return parseInt(process.env.PORT || '3000', 10); },
    get domain() { return process.env.DOMAIN; },
    get storagePath() { return process.env.STORAGE_PATH; },
    get chunksPath() { return process.env.CHUNKS_PATH; },
    get dbPath() { return process.env.DB_PATH; },
    get masterSecret() { return process.env.MASTER_SECRET; },
    get jwtSecret() { return process.env.JWT_SECRET; },
    get csrfSecret() { return process.env.CSRF_SECRET; },
    get ipHmacKey() { return process.env.IP_HMAC_KEY; },
    get maxFileSizeMb() { return parseInt(process.env.MAX_FILE_SIZE_MB || '5120', 10); },
    get nodeEnv() { return process.env.NODE_ENV || 'development'; },
  },
};
