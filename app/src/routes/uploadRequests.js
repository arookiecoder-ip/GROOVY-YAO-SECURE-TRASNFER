const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/db');
const { config } = require('../config');
const {
  createEncryptStream,
  encryptFilename,
} = require('../services/encryption');
const { broadcast } = require('./ws');

const MAX_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days to use the link

function ipHash(ip) {
  return crypto
    .createHmac('sha256', Buffer.from(config.ipHmacKey, 'hex'))
    .update(ip || '')
    .digest('hex');
}

function storagePath(storageId) {
  return path.join(config.storagePath, storageId);
}

function uploadLandingPage(state, token, nonce) {
  const states = {
    valid: {
      title: 'UPLOAD FILE',
      color: '#00f5ff',
      body: `
        <div class="drop-zone" id="dz">
          <div class="drop-icon">⬡</div>
          <div class="drop-text">DROP FILES HERE</div>
          <div class="drop-sub">or click to browse — multiple files allowed</div>
          <input type="file" id="fi" class="fi-hidden" multiple />
        </div>
        <div id="file-list"></div>
        <script nonce="${nonce}">
          (function() {
            const token = ${JSON.stringify(token)};
            const dz = document.getElementById('dz');
            const fi = document.getElementById('fi');
            const fileList = document.getElementById('file-list');
            const CHUNK = 64 * 1024 * 1024;
            const PARALLEL_CHUNKS = 3;
            let activeUploads = 0;

            window.addEventListener('beforeunload', e => {
              if (activeUploads > 0) {
                e.preventDefault();
                e.returnValue = '';
              }
            });

            dz.addEventListener('click', () => fi.click());
            dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dz-over'); });
            dz.addEventListener('dragleave', () => dz.classList.remove('dz-over'));
            dz.addEventListener('drop', e => {
              e.preventDefault();
              dz.classList.remove('dz-over');
              if (e.dataTransfer.files.length) startBatch(Array.from(e.dataTransfer.files));
            });
            fi.addEventListener('change', () => {
              if (fi.files.length) startBatch(Array.from(fi.files));
              fi.value = '';
            });

            async function startBatch(files) {
              for (const file of files) {
                const row = addRow(file.name);
                if (file.size > ${MAX_SIZE}) {
                  setRowError(row, 'exceeds 10 GB limit');
                  continue;
                }
                activeUploads++;
                try {
                  if (file.size <= 50 * 1024 * 1024) {
                    await simpleUpload(file, row);
                  } else {
                    await chunkedUpload(file, row);
                  }
                } catch(err) {
                  if (err.name === 'AbortError') setRowCancelled(row);
                  else setRowError(row, err.message || 'Upload failed');
                } finally {
                  activeUploads--;
                }
              }
            }

            function addRow(name) {
              const row = document.createElement('div');
              row.className = 'file-row';
              row.innerHTML =
                '<div class="fr-header"><span class="fr-name">' + escHtml(name) + '</span><button class="fr-cancel" title="Cancel">✕</button></div>' +
                '<div class="fr-track"><div class="fr-bar"></div></div>' +
                '<div class="fr-meta"><span class="fr-status">waiting…</span><span class="fr-speed"></span></div>';
              fileList.appendChild(row);
              row._abortController = new AbortController();
              row.querySelector('.fr-cancel').addEventListener('click', () => {
                if (window.confirm('Cancel this upload?')) row._abortController.abort();
              });
              return row;
            }

            function fmtSpeed(bps) {
              if (bps >= 1e9) return (bps / 1e9).toFixed(1) + ' GB/s';
              if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' MB/s';
              if (bps >= 1e3) return (bps / 1e3).toFixed(0) + ' KB/s';
              return bps.toFixed(0) + ' B/s';
            }

            function fmtEta(secs) {
              if (!isFinite(secs) || secs <= 0) return '';
              if (secs < 60) return secs.toFixed(0) + 's';
              return Math.ceil(secs / 60) + 'm';
            }

            function setRowProgress(row, pct, loaded, total, startTime) {
              row.querySelector('.fr-bar').style.width = pct + '%';
              row.querySelector('.fr-status').textContent = pct + '%';
              const elapsed = (Date.now() - startTime) / 1000;
              if (elapsed > 0.5 && loaded > 0) {
                const bps = loaded / elapsed;
                const eta = (total - loaded) / bps;
                row.querySelector('.fr-speed').textContent = fmtSpeed(bps) + (eta > 1 ? '  ETA ' + fmtEta(eta) : '');
              }
            }

            function setRowDone(row) {
              row.querySelector('.fr-cancel').style.display = 'none';
              row.querySelector('.fr-bar').style.width = '100%';
              row.querySelector('.fr-bar').style.background = '#00ff88';
              row.querySelector('.fr-status').textContent = '✓ done';
              row.querySelector('.fr-status').style.color = '#00ff88';
              row.querySelector('.fr-speed').textContent = '';
            }

            function setRowCancelled(row) {
              row.querySelector('.fr-cancel').style.display = 'none';
              row.querySelector('.fr-bar').style.background = '#ff9900';
              row.querySelector('.fr-status').textContent = '— cancelled';
              row.querySelector('.fr-status').style.color = '#ff9900';
              row.querySelector('.fr-speed').textContent = '';
            }

            function setRowError(row, msg) {
              row.querySelector('.fr-cancel').style.display = 'none';
              row.querySelector('.fr-bar').style.background = '#ff4444';
              row.querySelector('.fr-status').textContent = '✗ ' + msg;
              row.querySelector('.fr-status').style.color = '#ff4444';
              row.querySelector('.fr-speed').textContent = '';
            }

            async function simpleUpload(file, row) {
              return new Promise((resolve, reject) => {
                const startTime = Date.now();
                const fd = new FormData();
                fd.append('file', file);
                const xhr = new XMLHttpRequest();
                row._abortController.signal.addEventListener('abort', () => { xhr.abort(); reject(new DOMException('Cancelled', 'AbortError')); });
                xhr.open('POST', '/api/u/' + token + '/upload');
                xhr.upload.onprogress = e => {
                  if (e.lengthComputable) setRowProgress(row, Math.round(e.loaded / e.total * 100), e.loaded, e.total, startTime);
                };
                xhr.onload = () => {
                  if (xhr.status >= 200 && xhr.status < 300) {
                    setRowDone(row);
                    resolve();
                  } else {
                    const e = JSON.parse(xhr.responseText || '{}');
                    reject(new Error(e.error || 'Upload failed'));
                  }
                };
                xhr.onerror = () => reject(new Error('Network error'));
                xhr.send(fd);
              });
            }

            async function chunkedUpload(file, row) {
              const totalChunks = Math.ceil(file.size / CHUNK);
              const initRes = await fetch('/api/u/' + token + '/chunked/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  filename: file.name,
                  mimeType: file.type || 'application/octet-stream',
                  totalSize: file.size,
                  totalChunks,
                }),
              });
              if (!initRes.ok) { const e = await initRes.json().catch(()=>({})); throw new Error(e.error || 'Init failed'); }
              const { uploadId } = await initRes.json();

              const startTime = Date.now();
              // per-chunk byte progress tracked separately so parallel uploads sum correctly
              const chunkProgress = new Array(totalChunks).fill(0);

              function onChunkProgress(i, loaded) {
                chunkProgress[i] = loaded;
                const totalLoaded = chunkProgress.reduce((a, b) => a + b, 0);
                setRowProgress(row, Math.min(99, Math.round(totalLoaded / file.size * 100)), totalLoaded, file.size, startTime);
              }

              async function uploadChunk(i) {
                if (row._abortController.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
                const start = i * CHUNK;
                const slice = file.slice(start, start + CHUNK);
                await new Promise((resolve, reject) => {
                  const fd = new FormData();
                  fd.append('chunk', slice, 'chunk-' + i);
                  const xhr = new XMLHttpRequest();
                  row._abortController.signal.addEventListener('abort', () => { xhr.abort(); reject(new DOMException('Cancelled', 'AbortError')); });
                  xhr.open('PUT', '/api/u/' + token + '/chunked/' + uploadId + '/chunk/' + i);
                  xhr.upload.onprogress = e => { if (e.lengthComputable) onChunkProgress(i, e.loaded); };
                  xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) { onChunkProgress(i, slice.size); resolve(); }
                    else { const e = JSON.parse(xhr.responseText || '{}'); reject(new Error(e.error || 'Chunk failed')); }
                  };
                  xhr.onerror = () => reject(new Error('Network error'));
                  xhr.send(fd);
                });
              }

              // sliding window: PARALLEL_CHUNKS in-flight at once
              let next = 0;
              async function worker() {
                while (next < totalChunks) {
                  const i = next++;
                  await uploadChunk(i);
                }
              }
              await Promise.all(Array.from({ length: PARALLEL_CHUNKS }, worker));

              const finRes = await fetch('/api/u/' + token + '/chunked/' + uploadId + '/finalize', { method: 'POST' });
              if (!finRes.ok) { const e = await finRes.json().catch(()=>({})); throw new Error(e.error || 'Finalize failed'); }
              setRowDone(row);
            }

            function escHtml(s) {
              return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            }
          })();
        </script>`,
    },
    used: {
      title: 'LINK USED',
      color: '#ff4444',
      body: '<div class="info-msg">This upload link has already been used.</div>',
    },
    expired: {
      title: 'LINK EXPIRED',
      color: '#ff4444',
      body: '<div class="info-msg">This upload link has expired.</div>',
    },
    notfound: {
      title: 'INVALID LINK',
      color: '#ff4444',
      body: '<div class="info-msg">This upload link is invalid.</div>',
    },
  };

  const s = states[state] || states.notfound;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>GROOVY YAO // ${s.title}</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpolygon points='16,2 30,9 30,23 16,30 2,23 2,9' fill='%23050a0e' stroke='%2300f5ff' stroke-width='2'/%3E%3Cpolygon points='16,8 24,12 24,20 16,24 8,20 8,12' fill='%2300f5ff' opacity='0.3'/%3E%3C/svg%3E"/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#050a0e;color:#00f5ff;font-family:'JetBrains Mono',monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{border:1px solid #00f5ff44;padding:48px 40px;max-width:520px;width:100%}
    .brand{font-size:.75rem;letter-spacing:.2em;color:#00f5ff88;margin-bottom:32px}
    .page-title{font-size:1rem;font-weight:700;letter-spacing:.15em;color:${s.color};margin-bottom:24px}
    .drop-zone{border:2px dashed #00f5ff44;padding:40px 24px;text-align:center;cursor:pointer;transition:border-color .2s,background .2s}
    .drop-zone:hover,.dz-over{border-color:#00f5ff;background:#00f5ff0a}
    .drop-icon{font-size:2.5rem;color:#00f5ff66;margin-bottom:12px}
    .drop-text{font-size:.95rem;font-weight:700;letter-spacing:.1em;margin-bottom:4px}
    .drop-sub{font-size:.75rem;color:#00f5ff66}
    .fi-hidden{display:none}
    #file-list{margin-top:16px;display:flex;flex-direction:column;gap:10px}
    .file-row{padding:10px 0;border-bottom:1px solid #00f5ff11}
    .fr-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;gap:8px}
    .fr-name{font-size:.8rem;color:#ccc;word-break:break-all;flex:1}
    .fr-cancel{background:none;border:1px solid #ff444466;color:#ff4444;font-size:.65rem;cursor:pointer;padding:1px 5px;border-radius:2px;flex-shrink:0;transition:background .15s}
    .fr-cancel:hover{background:#ff44441a}
    .fr-track{height:4px;background:#00f5ff22;border-radius:2px;overflow:hidden;margin-bottom:4px}
    .fr-bar{height:100%;background:#00f5ff;width:0;transition:width .15s}
    .fr-meta{display:flex;justify-content:space-between;align-items:center}
    .fr-status{font-size:.72rem;color:#00f5ff88}
    .fr-speed{font-size:.72rem;color:#00f5ff66;letter-spacing:.04em}
    .info-msg{font-size:.9rem;color:#ccc;text-align:center;line-height:1.6}
    .hidden{display:none!important}
    .gh-footer{margin-top:24px;text-align:center}
    .gh-link{display:inline-flex;align-items:center;gap:6px;color:#ffffff33;text-decoration:none;font-size:.68rem;letter-spacing:.08em;transition:color .15s}
    .gh-link:hover{color:#00f5ff}
    .gh-link svg{fill:currentColor}
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">GROOVY YAO // SECURE FILE TRANSFER</div>
    <div class="page-title">// ${s.title}</div>
    ${s.body}
    <div class="gh-footer">
      <a href="https://github.com/arookiecoder-ip" target="_blank" rel="noopener" class="gh-link">
        <svg width="13" height="13" viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        arookiecoder-ip
      </a>
    </div>
  </div>
</body>
</html>`;
}

async function uploadRequestRoutes(fastify) {
  // ── Create upload request (auth required) ────────────────────────────────
  fastify.post('/upload-requests', async (req, reply) => {
    const token = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const id = uuidv4();
    const db = getDb();

    const rawMaxUses = req.body?.max_uses;
    const maxUses = rawMaxUses === 0 ? 0 : (parseInt(rawMaxUses, 10) || 1);
    if (maxUses !== 0 && (maxUses < 1 || maxUses > 1000)) {
      return reply.code(400).send({ error: 'max_uses must be 0 (unlimited) or 1–1000' });
    }

    db.prepare(`
      INSERT INTO upload_requests (id, token, used, max_uses, use_count, created_at, expires_at)
      VALUES (?, ?, 0, ?, 0, ?, ?)
    `).run(id, token, maxUses, now, now + TOKEN_TTL);

    const url = `${config.domain}/api/u/${token}`;
    return reply.code(201).send({ id, url, token, expires_at: now + TOKEN_TTL, max_uses: maxUses });
  });

  // ── List upload requests (auth required) ─────────────────────────────────
  fastify.get('/upload-requests', async (req, reply) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, token, used, created_at, expires_at, file_id
      FROM upload_requests
      ORDER BY created_at DESC
      LIMIT 100
    `).all();
    const now = Date.now();
    const list = rows.map((r) => ({
      id: r.id,
      url: `${config.domain}/api/u/${r.token}`,
      used: r.used === 1,
      expired: r.expires_at < now,
      created_at: r.created_at,
      expires_at: r.expires_at,
      file_id: r.file_id || null,
    }));
    return reply.send({ requests: list });
  });

  // ── Deactivate upload request (auth required) ────────────────────────────
  fastify.delete('/upload-requests/:id', async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT id FROM upload_requests WHERE id = ?').get(req.params.id);
    if (!row) return reply.code(404).send({ error: 'Not found' });
    db.prepare('UPDATE upload_requests SET used = 1 WHERE id = ?').run(req.params.id);
    return reply.send({ ok: true });
  });

  // ── Upload landing page (public) ─────────────────────────────────────────
  fastify.get('/u/:token', { config: { public: true } }, async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM upload_requests WHERE token = ?').get(req.params.token);
    const nonce = crypto.randomBytes(16).toString('base64');
    reply.header('Content-Security-Policy',
      `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`
    );

    if (!row) return reply.type('text/html').send(uploadLandingPage('notfound', null, nonce));
    if (row.used) return reply.type('text/html').send(uploadLandingPage('used', null, nonce));
    if (row.expires_at < Date.now()) return reply.type('text/html').send(uploadLandingPage('expired', null, nonce));

    return reply.type('text/html').send(uploadLandingPage('valid', req.params.token, nonce));
  });

  // ── Simple upload via token (public) ────────────────────────────────────
  fastify.post('/u/:token/upload', { config: { public: true } }, async (req, reply) => {
    const db = getDb();

    // Atomic check-and-increment
    const row = db.prepare('SELECT * FROM upload_requests WHERE token = ? AND used = 0').get(req.params.token);
    if (!row) return reply.code(410).send({ error: 'Link already used or invalid' });
    if (row.expires_at < Date.now()) return reply.code(410).send({ error: 'Link expired' });

    const maxUses = row.max_uses ?? 1;
    const newCount = (row.use_count ?? 0) + 1;
    const exhausted = maxUses !== 0 && newCount >= maxUses;
    const updated = db.prepare(
      'UPDATE upload_requests SET use_count = ?, used = ? WHERE token = ? AND used = 0'
    ).run(newCount, exhausted ? 1 : 0, req.params.token);
    if (updated.changes === 0) return reply.code(410).send({ error: 'Link already used' });

    const data = await req.file({ limits: { fileSize: MAX_SIZE } });
    if (!data) return reply.code(400).send({ error: 'No file' });

    const fileId = uuidv4();
    const storageId = uuidv4();
    const filePath = storagePath(storageId);
    const now = Date.now();

    fs.mkdirSync(config.storagePath, { recursive: true });

    const encStream = createEncryptStream(fileId);
    const outStream = fs.createWriteStream(filePath);
    const hasher = crypto.createHash('sha256');

    let keydata = null;
    encStream.once('keydata', (kd) => { keydata = kd; });

    let totalSize = 0;

    try {
      await new Promise((resolve, reject) => {
        data.file.on('data', (chunk) => {
          hasher.update(chunk);
          totalSize += chunk.length;
          encStream.write(chunk);
        });
        data.file.on('end', () => encStream.end());
        data.file.on('error', reject);
        encStream.pipe(outStream);
        outStream.on('finish', resolve);
        outStream.on('error', reject);
        encStream.on('error', reject);
      });
    } catch (err) {
      fs.unlink(filePath, () => {});
      req.log.error(err, 'upload-request encrypt failed');
      return reply.code(500).send({ error: 'Upload failed' });
    }

    if (!keydata) {
      fs.unlink(filePath, () => {});
      return reply.code(500).send({ error: 'Encryption key not generated' });
    }

    const sha256 = hasher.digest('hex');
    const { ciphertext: encName, iv: nameIv, tag: nameTag } = encryptFilename(data.filename, fileId);
    const mimeType = data.mimetype || 'application/octet-stream';

    db.prepare(`
      INSERT INTO files
        (id, storage_id, original_name, original_name_iv, mime_type, size_bytes, sha256,
         encryption_iv, encryption_tag, expires_at, created_at, download_count, status)
      VALUES (?,?,?,?,?,?,?,?,?,NULL,?,0,'complete')
    `).run(
      fileId, storageId, encName, nameIv, mimeType, totalSize, sha256,
      keydata.salt + ':' + keydata.iv, keydata.tag + ':' + nameTag, now,
    );

    db.prepare('UPDATE upload_requests SET file_id = ? WHERE token = ?').run(fileId, req.params.token);

    db.prepare(`
      INSERT INTO transfer_history (id, event_type, file_id, size_bytes, ip_hash, timestamp, metadata)
      VALUES (?,?,?,?,?,?,?)
    `).run(uuidv4(), 'upload', fileId, totalSize, ipHash(req.ip), now,
      JSON.stringify({ method: 'upload-request', filename: data.filename }));

    broadcast('FILE_ADDED', { fileId });

    return reply.code(201).send({ filename: data.filename });
  });

  // ── Chunked init via token (public) ─────────────────────────────────────
  fastify.post('/u/:token/chunked/init', { config: { public: true } }, async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM upload_requests WHERE token = ? AND used = 0').get(req.params.token);
    if (!row) return reply.code(410).send({ error: 'Link already used or invalid' });
    if (row.expires_at < Date.now()) return reply.code(410).send({ error: 'Link expired' });

    const { filename, mimeType, totalSize, totalChunks } = req.body || {};
    if (!filename || !mimeType || !totalSize || !totalChunks) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }
    if (totalSize > MAX_SIZE) return reply.code(413).send({ error: 'File exceeds 10 GB limit' });
    if (totalChunks < 1 || totalChunks > 10000) return reply.code(400).send({ error: 'Invalid chunk count' });

    const maxUses = row.max_uses ?? 1;
    const newCount = (row.use_count ?? 0) + 1;
    const exhausted = maxUses !== 0 && newCount >= maxUses;
    const updated = db.prepare(
      'UPDATE upload_requests SET use_count = ?, used = ? WHERE token = ? AND used = 0'
    ).run(newCount, exhausted ? 1 : 0, req.params.token);
    if (updated.changes === 0) return reply.code(410).send({ error: 'Link already used' });

    const uploadId = uuidv4();
    const now = Date.now();

    db.prepare(`
      INSERT INTO uploads
        (id, original_name, original_name_iv, mime_type, total_size, total_chunks,
         sha256_expected, expires_in, created_at, updated_at, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,'in_progress')
    `).run(uploadId, filename, '', mimeType, totalSize, totalChunks, 'none', 'never', now, now);

    const chunkDir = path.join(config.chunksPath, uploadId);
    fs.mkdirSync(chunkDir, { recursive: true });

    // Link the upload session to the request token so finalize can use it
    db.prepare('UPDATE upload_requests SET pending_upload_id = ? WHERE token = ?').run(uploadId, req.params.token);

    return reply.code(201).send({ uploadId, receivedChunks: [] });
  });

  // ── Chunk PUT via token (public) ─────────────────────────────────────────
  fastify.put('/u/:token/chunked/:uploadId/chunk/:index', { config: { public: true } }, async (req, reply) => {
    const db = getDb();
    const tokenRow = db.prepare('SELECT * FROM upload_requests WHERE token = ? AND pending_upload_id = ?')
      .get(req.params.token, req.params.uploadId);
    if (!tokenRow) return reply.code(404).send({ error: 'Invalid session' });

    const { uploadId, index } = req.params;
    const chunkIndex = parseInt(index, 10);
    if (isNaN(chunkIndex) || chunkIndex < 0) return reply.code(400).send({ error: 'Invalid chunk index' });

    const upload = db.prepare('SELECT * FROM uploads WHERE id = ? AND status = ?').get(uploadId, 'in_progress');
    if (!upload) return reply.code(404).send({ error: 'Upload not found' });
    if (chunkIndex >= upload.total_chunks) return reply.code(400).send({ error: 'Chunk index out of range' });

    const existing = db.prepare('SELECT chunk_index FROM upload_chunks WHERE upload_id = ? AND chunk_index = ?').get(uploadId, chunkIndex);
    if (existing) return reply.send({ ok: true, chunkIndex, duplicate: true });

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No chunk data' });

    const chunkPath = path.join(config.chunksPath, uploadId, `${chunkIndex}.chunk`);
    const chunks = [];
    let size = 0;

    try {
      await new Promise((resolve, reject) => {
        data.file.on('data', (c) => { chunks.push(c); size += c.length; });
        data.file.on('end', resolve);
        data.file.on('error', reject);
      });
    } catch (err) {
      req.log.error(err, 'chunk receive failed');
      return reply.code(500).send({ error: 'Chunk receive failed' });
    }

    fs.writeFileSync(chunkPath, Buffer.concat(chunks));
    const now = Date.now();
    db.prepare('INSERT INTO upload_chunks (upload_id, chunk_index, size_bytes, sha256, received_at) VALUES (?,?,?,?,?)')
      .run(uploadId, chunkIndex, size, '', now);
    db.prepare('UPDATE uploads SET updated_at = ? WHERE id = ?').run(now, uploadId);

    return reply.send({ ok: true, chunkIndex, size });
  });

  // ── Chunked finalize via token (public) ──────────────────────────────────
  fastify.post('/u/:token/chunked/:uploadId/finalize', { config: { public: true } }, async (req, reply) => {
    const db = getDb();
    const tokenRow = db.prepare('SELECT * FROM upload_requests WHERE token = ? AND pending_upload_id = ?')
      .get(req.params.token, req.params.uploadId);
    if (!tokenRow) return reply.code(404).send({ error: 'Invalid session' });

    const { uploadId } = req.params;
    const upload = db.prepare('SELECT * FROM uploads WHERE id = ? AND status = ?').get(uploadId, 'in_progress');
    if (!upload) return reply.code(404).send({ error: 'Upload not found or already finalized' });

    const received = db.prepare('SELECT * FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index').all(uploadId);
    if (received.length !== upload.total_chunks) {
      const missing = [];
      for (let i = 0; i < upload.total_chunks; i++) {
        if (!received.find((c) => c.chunk_index === i)) missing.push(i);
      }
      return reply.code(400).send({ error: 'Missing chunks', missing });
    }

    const chunkDir = path.join(config.chunksPath, uploadId);
    for (const chunk of received) {
      if (!fs.existsSync(path.join(chunkDir, `${chunk.chunk_index}.chunk`))) {
        return reply.code(500).send({ error: `Chunk file missing: ${chunk.chunk_index}` });
      }
    }

    const fileId = uuidv4();
    const storageId = uuidv4();
    const outPath = storagePath(storageId);
    fs.mkdirSync(config.storagePath, { recursive: true });

    const encStream = createEncryptStream(fileId);
    const outStream = fs.createWriteStream(outPath);
    const plainHasher = crypto.createHash('sha256');

    let keydata = null;
    encStream.once('keydata', (kd) => { keydata = kd; });

    try {
      await new Promise((resolve, reject) => {
        encStream.pipe(outStream);
        outStream.on('finish', resolve);
        outStream.on('error', reject);
        encStream.on('error', reject);

        (async () => {
          for (const chunk of received) {
            await new Promise((res, rej) => {
              const rs = fs.createReadStream(path.join(chunkDir, `${chunk.chunk_index}.chunk`));
              rs.on('data', (buf) => { plainHasher.update(buf); encStream.write(buf); });
              rs.on('end', res);
              rs.on('error', rej);
            });
          }
          encStream.end();
        })().catch(reject);
      });
    } catch (err) {
      fs.unlink(outPath, () => {});
      req.log.error(err, 'upload-request finalize encrypt failed');
      return reply.code(500).send({ error: 'Assembly failed' });
    }

    if (!keydata) {
      fs.unlink(outPath, () => {});
      return reply.code(500).send({ error: 'Encryption key not generated' });
    }

    const actualSha = plainHasher.digest('hex');
    const totalSize = received.reduce((s, c) => s + c.size_bytes, 0);
    const now = Date.now();

    const { ciphertext: encName, iv: nameIv, tag: nameTag } = encryptFilename(upload.original_name.trim(), fileId);

    db.prepare(`
      INSERT INTO files
        (id, storage_id, original_name, original_name_iv, mime_type, size_bytes, sha256,
         encryption_iv, encryption_tag, expires_at, created_at, download_count, status)
      VALUES (?,?,?,?,?,?,?,?,?,NULL,?,0,'complete')
    `).run(
      fileId, storageId, encName, nameIv, upload.mime_type, totalSize, actualSha,
      keydata.salt + ':' + keydata.iv, keydata.tag + ':' + nameTag, now,
    );

    db.prepare('UPDATE upload_requests SET file_id = ?, pending_upload_id = NULL WHERE token = ?').run(fileId, req.params.token);

    db.prepare(`
      INSERT INTO transfer_history (id, event_type, file_id, size_bytes, ip_hash, timestamp, metadata)
      VALUES (?,?,?,?,?,?,?)
    `).run(uuidv4(), 'upload', fileId, totalSize, ipHash(req.ip), now,
      JSON.stringify({ method: 'upload-request-chunked', chunks: upload.total_chunks }));

    db.prepare("UPDATE uploads SET status = 'complete', updated_at = ? WHERE id = ?").run(now, uploadId);

    try {
      fs.readdirSync(chunkDir).forEach((f) => fs.unlinkSync(path.join(chunkDir, f)));
      fs.rmdirSync(chunkDir);
    } catch { /* non-fatal */ }

    let filename = upload.original_name;
    try {
      const { decryptFilename } = require('../services/encryption');
      filename = decryptFilename(encName, nameIv, nameTag, fileId);
    } catch { /* fallback */ }

    broadcast('FILE_ADDED', { fileId });

    return reply.code(201).send({ filename });
  });
}

module.exports = uploadRequestRoutes;
