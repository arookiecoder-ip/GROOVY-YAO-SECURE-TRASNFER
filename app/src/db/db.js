const Database = require('better-sqlite3');
const path = require('path');

let _db = null;

function getDb() {
  if (!_db) {
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../../../db/filetransfer.db');
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    // Fix #20: prevent SQLITE_BUSY errors under concurrent load
    _db.pragma('busy_timeout = 5000');
  }
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, closeDb };
