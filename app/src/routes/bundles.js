const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/db');
const { config } = require('../config');
const { decryptFilename } = require('../services/encryption');

// Max files per bundle
const MAX_BUNDLE_FILES = 50;

function safeDecryptName(row) {
  try {
    const tagParts = (row.encryption_tag || '').split(':');
    if (tagParts.length < 2 || !tagParts[1]) return '[encrypted]';
    return decryptFilename(row.original_name, row.original_name_iv, tagParts[1], row.id);
  } catch (_e) {
    return '[encrypted]';
  }
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(2) + ' MB';
  if (bytes >= 1024)       return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}

function bundleLandingPage(bundle, files) {
  const totalSize = files.reduce((s, f) => s + f.size_bytes, 0);
  const createdAt = new Date(bundle.created_at).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const fileRows = files.map((f, i) => `
    <div class="bf-row">
      <div class="bf-row-info">
        <span class="bf-num">${i + 1}</span>
        <div class="bf-details">
          <div class="bf-name" title="${f.name.replace(/"/g, '&quot;')}">${f.name.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
          <div class="bf-size">${formatBytes(f.size_bytes)}</div>
        </div>
      </div>
      <a href="/api/bundles/${bundle.token}/file/${f.id}" class="bf-dl-btn" download="${f.name.replace(/"/g, '&quot;')}">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M2 13h12"/></svg>
      </a>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>GROOVY YAO // BUNDLE</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#050a0e;color:#00f5ff;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{border:1px solid #00f5ff44;padding:32px 28px;max-width:520px;width:100%}
    .brand{font-size:.7rem;letter-spacing:.2em;color:#00f5ff66;margin-bottom:24px}
    .bundle-title{font-size:1rem;font-weight:700;letter-spacing:.15em;color:#fff;margin-bottom:4px}
    .bundle-meta{font-size:.72rem;color:#00f5ff66;margin-bottom:24px;display:flex;gap:16px;flex-wrap:wrap}
    .bf-list{display:flex;flex-direction:column;gap:8px;margin-bottom:24px;max-height:360px;overflow-y:auto}
    .bf-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #00f5ff22;background:#0a1520}
    .bf-row-info{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
    .bf-num{font-size:.68rem;color:#00f5ff44;width:16px;flex-shrink:0;text-align:right}
    .bf-details{min-width:0;flex:1}
    .bf-name{font-size:.82rem;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .bf-size{font-size:.68rem;color:#00f5ff66;margin-top:2px}
    .bf-dl-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid #00f5ff44;color:#00f5ff;text-decoration:none;flex-shrink:0;transition:background .15s,border-color .15s}
    .bf-dl-btn:hover{background:#00f5ff1a;border-color:#00f5ff}
    .btn-all{display:block;width:100%;padding:13px;border:1px solid #00ff88;color:#00ff88;background:transparent;font-family:inherit;font-size:.85rem;font-weight:700;letter-spacing:.12em;cursor:pointer;text-align:center;transition:background .15s,color .15s;margin-bottom:8px}
    .btn-all:hover{background:#00ff88;color:#000}
    .footer{margin-top:16px;text-align:center;font-size:.65rem;color:#ffffff22;letter-spacing:.08em}
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">GROOVY YAO // SECURE FILE TRANSFER</div>
    <div class="bundle-title">⬡ FILE BUNDLE</div>
    <div class="bundle-meta">
      <span>${files.length} file${files.length !== 1 ? 's' : ''}</span>
      <span>${formatBytes(totalSize)} total</span>
      <span>shared ${createdAt}</span>
    </div>
    <div class="bf-list">${fileRows}</div>
    <button class="btn-all" id="btn-dl-all">⬇ DOWNLOAD ALL FILES</button>
    <div class="footer">// ENCRYPTED TRANSFER — GROOVY YAO</div>
  </div>
  <script>
    document.getElementById('btn-dl-all').addEventListener('click', async function() {
      const links = document.querySelectorAll('.bf-dl-btn');
      this.textContent = 'DOWNLOADING...';
      this.disabled = true;
      for (let i = 0; i < links.length; i++) {
        const a = document.createElement('a');
        a.href = links[i].href;
        a.download = links[i].download || '';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        if (i < links.length - 1) await new Promise(r => setTimeout(r, 900));
      }
      this.textContent = '✓ ALL DOWNLOADS STARTED';
    });
  </script>
</body>
</html>`;
}

async function bundlesRoutes(fastify) {

  // Ensure bundles table exists — self-healing for servers that were running
  // before this migration was added (avoids requiring a manual restart)
  const { getDb: _getDb } = require('../db/db');
  try {
    const _db = _getDb();
    _db.exec(`
      CREATE TABLE IF NOT EXISTS bundles (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        file_ids TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        download_count INTEGER DEFAULT 0,
        revoked INTEGER DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bundles_token ON bundles(token);
    `);
  } catch (_e) { /* table already exists — ignore */ }

  // ── Create bundle (authenticated) ─────────────────────────────────────────
  fastify.post('/bundles', async (req, reply) => {
    const { fileIds, label } = req.body || {};

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return reply.code(400).send({ error: 'fileIds array required' });
    }
    if (fileIds.length > MAX_BUNDLE_FILES) {
      return reply.code(400).send({ error: `Max ${MAX_BUNDLE_FILES} files per bundle` });
    }

    const db = getDb();

    // Verify all files exist and are complete
    const files = fileIds.map(id =>
      db.prepare('SELECT id FROM files WHERE id = ? AND status = ?').get(id, 'complete')
    );
    const missing = fileIds.filter((id, i) => !files[i]);
    if (missing.length > 0) {
      return reply.code(400).send({ error: 'Some files not found', missing });
    }

    // Short token: 9 bytes = 12 base64url chars
    const token = crypto.randomBytes(9).toString('base64url');
    const id = uuidv4();
    const now = Date.now();

    db.prepare(`
      INSERT INTO bundles (id, token, file_ids, label, created_at, expires_at, download_count, revoked)
      VALUES (?, ?, ?, ?, ?, NULL, 0, 0)
    `).run(id, token, JSON.stringify(fileIds), label || null, now);

    const url = `${config.domain}/b/${token}`;
    return reply.code(201).send({ id, token, url });
  });

  // ── List bundles (authenticated) ───────────────────────────────────────────
  fastify.get('/bundles', async (req, reply) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, token, file_ids, label, created_at, expires_at, download_count, revoked
      FROM bundles ORDER BY created_at DESC LIMIT 100
    `).all();

    const now = Date.now();
    const list = rows.map(r => ({
      id: r.id,
      url: `${config.domain}/b/${r.token}`,
      token: r.token,
      fileCount: JSON.parse(r.file_ids || '[]').length,
      label: r.label || null,
      created_at: r.created_at,
      expires_at: r.expires_at || null,
      download_count: r.download_count,
      revoked: r.revoked === 1,
      expired: r.expires_at ? r.expires_at < now : false,
    }));
    return reply.send({ bundles: list });
  });

  // ── Revoke bundle (authenticated) ──────────────────────────────────────────
  fastify.delete('/bundles/:id', async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT id FROM bundles WHERE id = ?').get(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Bundle not found' });
    db.prepare('UPDATE bundles SET revoked = 1 WHERE id = ?').run(req.params.id);
    return reply.send({ ok: true });
  });

  // ── Bundle landing page — backward compat redirect to short URL ───────────
  fastify.get('/bundles/:token', { config: { public: true } }, async (req, reply) => {
    return reply.redirect(301, `/b/${req.params.token}`);
  });

  // ── Download individual file from bundle (public) ──────────────────────────
  // Keep old path working for any existing links
  fastify.get('/bundles/:token/file/:fileId', { config: { public: true } }, async (req, reply) => {
    return reply.redirect(301, `/b/${req.params.token}/file/${req.params.fileId}`);
  });
}

function _errorPage(msg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>GROOVY YAO // ERROR</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#050a0e;color:#00f5ff;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{border:1px solid #ff444444;padding:40px;max-width:400px;width:100%;text-align:center}
    .icon{font-size:2.5rem;color:#ff4444;margin-bottom:16px}
    .title{font-size:1rem;font-weight:700;color:#ff4444;letter-spacing:.15em;margin-bottom:12px}
    .msg{font-size:.85rem;color:#ccc;line-height:1.6}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⬡</div>
    <div class="title">// ACCESS DENIED</div>
    <div class="msg">${msg}</div>
  </div>
</body>
</html>`;
}

module.exports = bundlesRoutes;

// ── Short public route: /b/:token ─────────────────────────────────────────
// Registered at root level (no /api prefix) for short bundle URLs.
async function bundlesShortRoute(fastify) {
  const fs = require('fs');
  const path = require('path');
  const { createDecryptStream } = require('../services/encryption');

  // Bundle landing page
  fastify.get('/b/:token', { config: { public: true } }, async (req, reply) => {
    const db = getDb();
    const bundle = db.prepare('SELECT * FROM bundles WHERE token = ?').get(req.params.token);

    if (!bundle || bundle.revoked) {
      return reply.code(404).type('text/html').send(_errorPage('Bundle not found or has been revoked.'));
    }
    if (bundle.expires_at && bundle.expires_at < Date.now()) {
      return reply.code(410).type('text/html').send(_errorPage('This bundle has expired.'));
    }

    const fileIds = JSON.parse(bundle.file_ids || '[]');
    const files = fileIds
      .map(id => db.prepare('SELECT * FROM files WHERE id = ? AND status = ?').get(id, 'complete'))
      .filter(Boolean)
      .map(row => ({ ...row, name: safeDecryptName(row) }));

    if (files.length === 0) {
      return reply.code(404).type('text/html').send(_errorPage('No files available in this bundle.'));
    }

    db.prepare('UPDATE bundles SET download_count = download_count + 1 WHERE token = ?').run(req.params.token);

    // Render with short file download URLs
    return reply.type('text/html').send(bundleLandingPageShort(bundle, files));
  });

  // Individual file download from bundle
  fastify.get('/b/:token/file/:fileId', { config: { public: true } }, async (req, reply) => {
    const db = getDb();
    const bundle = db.prepare('SELECT * FROM bundles WHERE token = ?').get(req.params.token);

    if (!bundle || bundle.revoked) return reply.code(404).send({ error: 'Bundle not found' });
    if (bundle.expires_at && bundle.expires_at < Date.now()) return reply.code(410).send({ error: 'Bundle expired' });

    const fileIds = JSON.parse(bundle.file_ids || '[]');
    if (!fileIds.includes(req.params.fileId)) return reply.code(403).send({ error: 'File not in bundle' });

    const row = db.prepare('SELECT * FROM files WHERE id = ? AND status = ?').get(req.params.fileId, 'complete');
    if (!row) return reply.code(404).send({ error: 'File not found' });
    if (row.expires_at && row.expires_at < Date.now()) return reply.code(410).send({ error: 'File expired' });

    const filePath = path.join(config.storagePath, row.storage_id);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'Storage missing' });

    const saltHex = row.encryption_iv.split(':')[0];
    const filename = safeDecryptName(row);

    db.prepare('UPDATE files SET download_count = download_count + 1 WHERE id = ?').run(row.id);

    const safeFilename = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A');
    reply.header('Content-Type', row.mime_type || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${safeFilename}`);
    reply.header('X-Content-Type-Options', 'nosniff');

    const readStream = fs.createReadStream(filePath);
    const decStream = createDecryptStream(row.id, saltHex);
    readStream.on('error', (err) => { req.log.error(err, 'bundle file read error'); decStream.destroy(err); });
    decStream.on('error', (err) => { req.log.error(err, 'bundle file decrypt error'); if (!reply.sent) reply.raw.destroy(); });
    readStream.pipe(decStream);
    return reply.send(decStream);
  });
}

// Bundle landing page using short /b/:token/file/:id download URLs
function bundleLandingPageShort(bundle, files) {
  const totalSize = files.reduce((s, f) => s + f.size_bytes, 0);
  const createdAt = new Date(bundle.created_at).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const fileRows = files.map((f, i) => `
    <div class="bf-row">
      <div class="bf-row-info">
        <span class="bf-num">${i + 1}</span>
        <div class="bf-details">
          <div class="bf-name" title="${f.name.replace(/"/g, '&quot;')}">${f.name.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
          <div class="bf-size">${formatBytes(f.size_bytes)}</div>
        </div>
      </div>
      <a href="/b/${bundle.token}/file/${f.id}" class="bf-dl-btn" download="${f.name.replace(/"/g, '&quot;')}">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M2 13h12"/></svg>
      </a>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>GROOVY YAO // BUNDLE</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#050a0e;color:#00f5ff;font-family:'JetBrains Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{border:1px solid #00f5ff44;padding:32px 28px;max-width:520px;width:100%}
    .brand{font-size:.7rem;letter-spacing:.2em;color:#00f5ff66;margin-bottom:24px}
    .bundle-title{font-size:1rem;font-weight:700;letter-spacing:.15em;color:#fff;margin-bottom:4px}
    .bundle-meta{font-size:.72rem;color:#00f5ff66;margin-bottom:24px;display:flex;gap:16px;flex-wrap:wrap}
    .bf-list{display:flex;flex-direction:column;gap:8px;margin-bottom:24px;max-height:360px;overflow-y:auto}
    .bf-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #00f5ff22;background:#0a1520}
    .bf-row-info{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
    .bf-num{font-size:.68rem;color:#00f5ff44;width:16px;flex-shrink:0;text-align:right}
    .bf-details{min-width:0;flex:1}
    .bf-name{font-size:.82rem;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .bf-size{font-size:.68rem;color:#00f5ff66;margin-top:2px}
    .bf-dl-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid #00f5ff44;color:#00f5ff;text-decoration:none;flex-shrink:0;transition:background .15s,border-color .15s}
    .bf-dl-btn:hover{background:#00f5ff1a;border-color:#00f5ff}
    .btn-all{display:block;width:100%;padding:13px;border:1px solid #00ff88;color:#00ff88;background:transparent;font-family:inherit;font-size:.85rem;font-weight:700;letter-spacing:.12em;cursor:pointer;text-align:center;transition:background .15s,color .15s;margin-bottom:8px}
    .btn-all:hover{background:#00ff88;color:#000}
    .footer{margin-top:16px;text-align:center;font-size:.65rem;color:#ffffff22;letter-spacing:.08em}
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">GROOVY YAO // SECURE FILE TRANSFER</div>
    <div class="bundle-title">⬡ FILE BUNDLE</div>
    <div class="bundle-meta">
      <span>${files.length} file${files.length !== 1 ? 's' : ''}</span>
      <span>${formatBytes(totalSize)} total</span>
      <span>shared ${createdAt}</span>
    </div>
    <div class="bf-list">${fileRows}</div>
    <button class="btn-all" id="btn-dl-all">⬇ DOWNLOAD ALL FILES</button>
    <div class="footer">// ENCRYPTED TRANSFER — GROOVY YAO</div>
  </div>
  <script>
    document.getElementById('btn-dl-all').addEventListener('click', async function() {
      const links = document.querySelectorAll('.bf-dl-btn');
      this.textContent = 'DOWNLOADING...';
      this.disabled = true;
      for (let i = 0; i < links.length; i++) {
        const a = document.createElement('a');
        a.href = links[i].href;
        a.download = links[i].download || '';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        if (i < links.length - 1) await new Promise(r => setTimeout(r, 900));
      }
      this.textContent = '✓ ALL DOWNLOADS STARTED';
    });
  </script>
</body>
</html>`;
}

module.exports.bundlesShortRoute = bundlesShortRoute;
