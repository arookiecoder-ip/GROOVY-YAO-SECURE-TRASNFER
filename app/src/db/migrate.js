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
  console.log(`[migrate] Schema applied to ${dbPath}`);
  db.close();
}

migrate();
