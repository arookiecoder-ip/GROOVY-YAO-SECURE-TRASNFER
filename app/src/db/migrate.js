const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../../../db/filetransfer.db');
const schemaPath = path.join(__dirname, 'schema.sql');

function migrate() {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  const schema = fs.readFileSync(schemaPath, 'utf8');

  db.exec(schema);

  // Additive migrations for existing DBs
  const cols = db.prepare("PRAGMA table_info(files)").all().map(c => c.name);
  if (!cols.includes('is_public')) {
    db.exec('ALTER TABLE files ADD COLUMN is_public INTEGER DEFAULT 0');
    console.log('[migrate] Added is_public column to files');
  }

  // Add password_config table if missing
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='password_config'").get();
  if (!tables) {
    db.exec(`CREATE TABLE IF NOT EXISTS password_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`);
    console.log('[migrate] Created password_config table');
  }

  // Add device_tokens table if missing
  const dtTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='device_tokens'").get();
  if (!dtTable) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_device_tokens_hash ON device_tokens(token_hash);
    `);
    console.log('[migrate] Created device_tokens table');
  }

  console.log(`[migrate] Schema applied to ${dbPath}`);
  db.close();
}

migrate();
