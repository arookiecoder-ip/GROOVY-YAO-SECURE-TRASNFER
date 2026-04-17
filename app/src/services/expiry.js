const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/db');
const { config } = require('../config');

function deleteExpiredFiles() {
  const db = getDb();
  const now = Date.now();

  const expired = db.prepare(`
    SELECT id, storage_id FROM files
    WHERE expires_at IS NOT NULL AND expires_at < ? AND status = 'complete'
  `).all(now);

  if (expired.length === 0) return;

  for (const row of expired) {
    const filePath = path.join(config.storagePath, row.storage_id);
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  }

  const ids = expired.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...ids);

  // Prune old auth challenges too
  db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(now);

  // Prune used/old challenges older than 1 day
  db.prepare('DELETE FROM auth_challenges WHERE used = 1 AND expires_at < ?').run(now - 86400000);

  console.log(`[expiry] purged ${expired.length} expired file(s)`);
}

function startExpiryWatcher() {
  // Run every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    try { deleteExpiredFiles(); } catch (err) { console.error('[expiry] error:', err); }
  });

  // Run once at startup to handle any backlog
  try { deleteExpiredFiles(); } catch (err) { console.error('[expiry] startup error:', err); }
}

module.exports = { startExpiryWatcher, deleteExpiredFiles };
