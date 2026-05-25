const cron = require('node-cron');
const { getDb } = require('../db/db');
const { config } = require('../config');

// Stale in-progress uploads older than this are considered abandoned
const STALE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function deleteExpiredFiles() {
  const db = getDb();
  const now = Date.now();

  // Fix #15: only delete unused expired challenges (keep used ones for 1 day for audit)
  db.prepare('DELETE FROM auth_challenges WHERE used = 0 AND expires_at < ?').run(now);
  db.prepare('DELETE FROM auth_challenges WHERE used = 1 AND expires_at < ?').run(now - 86400000);

  // Fix #14: clean up stale in-progress uploads (abandoned > 24h ago)
  const staleUploads = db.prepare(`
    SELECT id FROM uploads
    WHERE status = 'in_progress' AND updated_at < ?
  `).all(now - STALE_UPLOAD_TTL_MS);

  for (const row of staleUploads) {
    const chunkDir = path.join(config.chunksPath, row.id);
    try {
      if (fs.existsSync(chunkDir)) {
        fs.readdirSync(chunkDir).forEach((f) => fs.unlinkSync(path.join(chunkDir, f)));
        fs.rmdirSync(chunkDir);
      }
    } catch (_e) { /* non-fatal */ }
  }

  if (staleUploads.length > 0) {
    const ids = staleUploads.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE uploads SET status = 'aborted' WHERE id IN (${placeholders})`).run(...ids);
    console.log(`[expiry] aborted ${staleUploads.length} stale upload(s)`);
  }

  // Clean up expired device tokens
  db.prepare('DELETE FROM device_tokens WHERE expires_at < ? OR revoked = 1').run(now - 86400000);
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
