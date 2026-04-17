const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const archiver = require('archiver');
const { validateFileType } = require('../middleware/fileType');
const { getDb } = require('../db/db');
const { config } = require('../config');
const {
  createEncryptStream,
  createDecryptStream,
  encryptFilename,
  decryptFilename,
} = require('../services/encryption');

const EXPIRY_OPTIONS = {
  '1h':    60 * 60 * 1000,
  '6h':    6 * 60 * 60 * 1000,
  '24h':   24 * 60 * 60 * 1000,
  '7d':    7 * 24 * 60 * 60 * 1000,
  '30d':   30 * 24 * 60 * 60 * 1000,
  'never': null,
};

function ipHash(ip) {
  return crypto
    .createHmac('sha256', Buffer.from(config.ipHmacKey, 'hex'))
    .update(ip || '')
    .digest('hex');
}

function storagePath(storageId) {
  return path.join(config.storagePath, storageId);
}

function buildFileRow(row) {
  let name = row.original_name;
  try {
    const nameTag = (row.encryption_tag || '').split(':')[1] || row.encryption_tag;
    name = decryptFilename(row.original_name, row.original_name_iv, nameTag, row.id);
  } catch { /* use raw if decryption fails (shouldn't happen) */ }
  return {
    id: row.id,
    name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    expires_at: row.expires_at || null,
    created_at: row.created_at,
    download_count: row.download_count,
    is_public: row.is_public === 1,
  };
}

async function filesRoutes(fastify) {
  // ── Simple upload (< 10MB sync) ──────────────────────────────────────────
  fastify.post('/upload/simple', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No file' });

    const expiresIn = req.body?.expires || data.fields?.expires?.value || '24h';
    const expiryMs = (expiresIn in EXPIRY_OPTIONS) ? EXPIRY_OPTIONS[expiresIn] : EXPIRY_OPTIONS['24h'];

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

    // Tee: hash the plaintext as it flows, encrypt to disk
    const chunks = [];
    let totalSize = 0;

    try {
      await new Promise((resolve, reject) => {
        data.file.on('data', (chunk) => {
          hasher.update(chunk);
          totalSize += chunk.length;
          chunks.push(chunk);
          encStream.write(chunk);
        });
        data.file.on('end', () => { encStream.end(); });
        data.file.on('error', reject);
        encStream.pipe(outStream);
        outStream.on('finish', resolve);
        outStream.on('error', reject);
        encStream.on('error', reject);
      });
    } catch (err) {
      fs.unlink(filePath, () => {});
      req.log.error(err, 'upload encrypt failed');
      return reply.code(500).send({ error: 'Upload failed' });
    }

    if (!keydata) {
      fs.unlink(filePath, () => {});
      return reply.code(500).send({ error: 'Encryption key not generated' });
    }

    const typeCheck = await validateFileType(Buffer.concat(chunks.slice(0, 4)), data.filename);
    if (!typeCheck.ok) {
      fs.unlink(filePath, () => {});
      return reply.code(422).send({ error: typeCheck.reason });
    }

    const sha256 = hasher.digest('hex');
    const { ciphertext: encName, iv: nameIv, tag: nameTag } = encryptFilename(data.filename, fileId);
    const mimeType = data.mimetype || 'application/octet-stream';
    const expiresAt = expiryMs !== null ? now + expiryMs : null;

    const db = getDb();
    db.prepare(`
      INSERT INTO files
        (id, storage_id, original_name, original_name_iv, mime_type, size_bytes, sha256,
         encryption_iv, encryption_tag, expires_at, created_at, download_count, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'complete')
    `).run(
      fileId, storageId, encName, nameIv, mimeType, totalSize, sha256,
      keydata.salt + ':' + keydata.iv, keydata.tag + ':' + nameTag,
      expiresAt, now,
    );

    db.prepare(`
      INSERT INTO transfer_history (id, event_type, file_id, size_bytes, ip_hash, timestamp, metadata)
      VALUES (?,?,?,?,?,?,?)
    `).run(uuidv4(), 'upload', fileId, totalSize, ipHash(req.ip), now,
      JSON.stringify({ method: 'simple', filename: data.filename }));

    return reply.code(201).send({
      fileId,
      filename: data.filename,
      size: totalSize,
      sha256,
      expires_at: expiresAt,
      never_expires: expiresAt === null,
      downloadUrl: `/api/files/${fileId}/download`,
    });
  });

  // ── Download ─────────────────────────────────────────────────────────────
  fastify.get('/files/:id/download', { config: { public: true } }, async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM files WHERE id = ? AND status = ?').get(req.params.id, 'complete');
    if (!row) return reply.code(404).send({ error: 'File not found' });
    if (row.expires_at && row.expires_at < Date.now()) {
      return reply.code(410).send({ error: 'File expired' });
    }
    if (!row.is_public) {
      const token = req.cookies?.access_token;
      if (!token) return reply.code(401).send({ error: 'This file is private' });
      try {
        const { verifyAccessToken, getSession } = require('../services/auth');
        const sessionId = await verifyAccessToken(token);
        if (!getSession(sessionId)) return reply.code(401).send({ error: 'Session revoked' });
      } catch {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    }

    const filePath = storagePath(row.storage_id);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'Storage missing' });

    // encryption_iv column stores "salt:iv_b64", encryption_tag stores "tag_b64:name_tag_b64"
    const saltHex = row.encryption_iv.split(':')[0];

    let filename;
    try {
      const nameTag = row.encryption_tag.split(':')[1];
      filename = decryptFilename(row.original_name, row.original_name_iv, nameTag, row.id);
    } catch {
      filename = 'download';
    }

    db.prepare('UPDATE files SET download_count = download_count + 1 WHERE id = ?').run(row.id);

    const now = Date.now();
    db.prepare(`
      INSERT INTO transfer_history (id, event_type, file_id, size_bytes, ip_hash, timestamp)
      VALUES (?,?,?,?,?,?)
    `).run(uuidv4(), 'download', row.id, row.size_bytes, ipHash(req.ip), now);

    const safeFilename = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A');
    reply.header('Content-Type', row.mime_type || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${safeFilename}`);
    reply.header('X-Content-Type-Options', 'nosniff');

    const readStream = fs.createReadStream(filePath);
    const decStream = createDecryptStream(row.id, saltHex);
    readStream.pipe(decStream);
    return reply.send(decStream);
  });

  // ── File listing ─────────────────────────────────────────────────────────
  fastify.get('/files', async (req, reply) => {
    const { sort = 'date', page = '1', limit = '50' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const ORDER = {
      date: 'created_at DESC',
      name: 'original_name ASC',
      size: 'size_bytes DESC',
    };
    const orderBy = ORDER[sort] || ORDER.date;

    const db = getDb();
    const rows = db.prepare(`
      SELECT * FROM files
      WHERE status = 'complete'
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(limitNum, offset);

    const total = db.prepare("SELECT COUNT(*) as n FROM files WHERE status = 'complete'").get().n;

    const files = rows.map(buildFileRow);
    return reply.send({ files, total, page: pageNum, limit: limitNum });
  });

  // ── Delete ────────────────────────────────────────────────────────────────
  fastify.delete('/files/:id', async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
    if (!row) return reply.code(404).send({ error: 'File not found' });

    const filePath = storagePath(row.storage_id);
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }

    db.prepare('DELETE FROM files WHERE id = ?').run(row.id);

    db.prepare(`
      INSERT INTO transfer_history (id, event_type, file_id, size_bytes, ip_hash, timestamp)
      VALUES (?,?,?,?,?,?)
    `).run(uuidv4(), 'delete', row.id, row.size_bytes, ipHash(req.ip), Date.now());

    return reply.send({ ok: true });
  });
  // ── QR code ───────────────────────────────────────────────────────────────
  fastify.get('/files/:id/qr', async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT id, original_name, original_name_iv, encryption_tag FROM files WHERE id = ? AND status = ?').get(req.params.id, 'complete');
    if (!row) return reply.code(404).send({ error: 'File not found' });

    const downloadUrl = `${config.domain}/api/files/${row.id}/download`;
    const dataUrl = await QRCode.toDataURL(downloadUrl, { width: 256, margin: 2 });
    return reply.send({ dataUrl, downloadUrl });
  });

  // ── Visibility toggle ─────────────────────────────────────────────────────
  fastify.patch('/files/:id/visibility', async (req, reply) => {
    const { isPublic } = req.body || {};
    if (typeof isPublic !== 'boolean') return reply.code(400).send({ error: 'isPublic boolean required' });
    const db = getDb();
    const row = db.prepare('SELECT id FROM files WHERE id = ? AND status = ?').get(req.params.id, 'complete');
    if (!row) return reply.code(404).send({ error: 'File not found' });
    db.prepare('UPDATE files SET is_public = ? WHERE id = ?').run(isPublic ? 1 : 0, req.params.id);
    return reply.send({ ok: true, isPublic });
  });

  // ── Extend expiry ─────────────────────────────────────────────────────────
  fastify.patch('/files/:id/expiry', async (req, reply) => {
    const { expiresIn } = req.body || {};
    if (!(expiresIn in EXPIRY_OPTIONS)) return reply.code(400).send({ error: 'Invalid expiresIn' });

    const db = getDb();
    const row = db.prepare('SELECT id, expires_at FROM files WHERE id = ? AND status = ?').get(req.params.id, 'complete');
    if (!row) return reply.code(404).send({ error: 'File not found' });

    let newExpiry;
    if (EXPIRY_OPTIONS[expiresIn] === null) {
      newExpiry = null;
    } else {
      const base = row.expires_at && row.expires_at > Date.now() ? row.expires_at : Date.now();
      newExpiry = base + EXPIRY_OPTIONS[expiresIn];
    }
    db.prepare('UPDATE files SET expires_at = ? WHERE id = ?').run(newExpiry, row.id);
    return reply.send({ ok: true, expires_at: newExpiry, never_expires: newExpiry === null });
  });

  // ── ZIP streaming (multi-file) ────────────────────────────────────────────
  fastify.post('/files/zip', async (req, reply) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return reply.code(400).send({ error: 'ids required' });
    if (ids.length > 50) return reply.code(400).send({ error: 'Max 50 files per ZIP' });

    const db = getDb();
    const files = ids.map((id) => db.prepare('SELECT * FROM files WHERE id = ? AND status = ?').get(id, 'complete')).filter(Boolean);
    if (files.length === 0) return reply.code(404).send({ error: 'No files found' });

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', 'attachment; filename="transfer.zip"');

    const archive = archiver('zip', { zlib: { level: 0 } });
    reply.send(archive);

    for (const row of files) {
      const saltHex = row.encryption_iv.split(':')[0];
      let filename;
      try {
        const nameTag = row.encryption_tag.split(':')[1];
        filename = decryptFilename(row.original_name, row.original_name_iv, nameTag, row.id);
      } catch { filename = row.id; }

      const filePath = storagePath(row.storage_id);
      if (!fs.existsSync(filePath)) continue;

      const readStream = fs.createReadStream(filePath);
      const decStream = createDecryptStream(row.id, saltHex);
      readStream.pipe(decStream);
      archive.append(decStream, { name: filename });
    }

    archive.finalize();
  });

  // ── Transfer history ──────────────────────────────────────────────────────
  fastify.get('/history', async (req, reply) => {
    const limit = Math.min(200, parseInt(req.query.limit || '100', 10));
    const db = getDb();
    const events = db.prepare(
      'SELECT * FROM transfer_history ORDER BY timestamp DESC LIMIT ?'
    ).all(limit);
    return reply.send(events);
  });

  fastify.delete('/history', async (req, reply) => {
    getDb().prepare('DELETE FROM transfer_history').run();
    return reply.send({ ok: true });
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  fastify.get('/stats', async (req, reply) => {
    const db = getDb();
    const files = db.prepare("SELECT COUNT(*) as count, SUM(size_bytes) as total_bytes FROM files WHERE status = 'complete'").get();
    const uploads = db.prepare("SELECT COUNT(*) as count, SUM(size_bytes) as total_bytes FROM transfer_history WHERE event_type = 'upload'").get();
    const downloads = db.prepare("SELECT COUNT(*) as count FROM transfer_history WHERE event_type = 'download'").get();
    const expired = db.prepare("SELECT COUNT(*) as count FROM transfer_history WHERE event_type = 'expire'").get();
    return reply.send({
      files: { count: files.count, total_bytes: files.total_bytes || 0 },
      uploads: { count: uploads.count, total_bytes: uploads.total_bytes || 0 },
      downloads: { count: downloads.count },
      expired: { count: expired.count },
    });
  });
}

module.exports = filesRoutes;
