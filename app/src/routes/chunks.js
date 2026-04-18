const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/db');
const { config } = require('../config');
const {
  createEncryptStream,
  encryptFilename,
  decryptFilename,
} = require('../services/encryption');
const { broadcast } = require('./ws');

const EXPIRY_OPTIONS = {
  '1h':  60 * 60 * 1000,
  '6h':  6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function ipHash(ip) {
  return crypto
    .createHmac('sha256', Buffer.from(config.ipHmacKey, 'hex'))
    .update(ip || '')
    .digest('hex');
}

function chunkDir(uploadId) {
  return path.join(config.chunksPath, uploadId);
}

function chunkFile(uploadId, index) {
  return path.join(chunkDir(uploadId), `${index}.chunk`);
}

function storagePath(storageId) {
  return path.join(config.storagePath, storageId);
}

async function chunksRoutes(fastify) {
  // ── Init upload ───────────────────────────────────────────────────────────
  fastify.post('/upload/chunked/init', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { filename, mimeType, totalSize, totalChunks, sha256, expiresIn = '24h' } = req.body || {};

    if (!filename || !mimeType || !totalSize || !totalChunks || !sha256) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }
    if (!EXPIRY_OPTIONS[expiresIn]) {
      return reply.code(400).send({ error: 'Invalid expiresIn' });
    }
    if (totalChunks < 1 || totalChunks > 10000) {
      return reply.code(400).send({ error: 'Invalid chunk count' });
    }

    const db = getDb();

    // Resume: check existing in-progress upload for same file
    const existing = db.prepare(`
      SELECT id FROM uploads
      WHERE original_name = ? AND total_size = ? AND sha256_expected = ? AND status = 'in_progress'
      ORDER BY created_at DESC LIMIT 1
    `).get(filename, totalSize, sha256);

    if (existing) {
      const received = db.prepare(
        'SELECT chunk_index FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index'
      ).all(existing.id).map((r) => r.chunk_index);

      return reply.send({ uploadId: existing.id, receivedChunks: received });
    }

    const uploadId = uuidv4();
    const now = Date.now();

    db.prepare(`
      INSERT INTO uploads
        (id, original_name, original_name_iv, mime_type, total_size, total_chunks,
         sha256_expected, expires_in, created_at, updated_at, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,'in_progress')
    `).run(uploadId, filename, '', mimeType, totalSize, totalChunks, sha256, expiresIn, now, now);

    fs.mkdirSync(chunkDir(uploadId), { recursive: true });

    return reply.code(201).send({ uploadId, receivedChunks: [] });
  });

  // ── Upload chunk ──────────────────────────────────────────────────────────
  fastify.put('/upload/chunked/:uploadId/chunk/:index', {
    config: { rateLimit: { max: 500, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uploadId, index } = req.params;
    const chunkIndex = parseInt(index, 10);

    if (isNaN(chunkIndex) || chunkIndex < 0) {
      return reply.code(400).send({ error: 'Invalid chunk index' });
    }

    const db = getDb();
    const upload = db.prepare('SELECT * FROM uploads WHERE id = ? AND status = ?').get(uploadId, 'in_progress');
    if (!upload) return reply.code(404).send({ error: 'Upload not found or already finalized' });

    if (chunkIndex >= upload.total_chunks) {
      return reply.code(400).send({ error: 'Chunk index out of range' });
    }

    // Already received — idempotent
    const existing = db.prepare(
      'SELECT chunk_index FROM upload_chunks WHERE upload_id = ? AND chunk_index = ?'
    ).get(uploadId, chunkIndex);
    if (existing) return reply.send({ ok: true, chunkIndex, duplicate: true });

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No chunk data' });

    const expectedSha = req.headers['x-chunk-sha256'];
    const outPath = chunkFile(uploadId, chunkIndex);

    const hasher = crypto.createHash('sha256');
    const chunks = [];
    let size = 0;

    try {
      await new Promise((resolve, reject) => {
        data.file.on('data', (c) => { hasher.update(c); chunks.push(c); size += c.length; });
        data.file.on('end', resolve);
        data.file.on('error', reject);
      });
    } catch (err) {
      req.log.error(err, 'chunk receive failed');
      return reply.code(500).send({ error: 'Chunk receive failed' });
    }

    const actualSha = hasher.digest('hex');
    if (expectedSha && actualSha !== expectedSha) {
      return reply.code(422).send({ error: 'Chunk SHA-256 mismatch', expected: expectedSha, actual: actualSha });
    }

    fs.writeFileSync(outPath, Buffer.concat(chunks));

    const now = Date.now();
    db.prepare(`
      INSERT INTO upload_chunks (upload_id, chunk_index, size_bytes, sha256, received_at)
      VALUES (?,?,?,?,?)
    `).run(uploadId, chunkIndex, size, actualSha, now);

    db.prepare('UPDATE uploads SET updated_at = ? WHERE id = ?').run(now, uploadId);

    // Emit progress event
    const receivedCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM upload_chunks WHERE upload_id = ?'
    ).get(uploadId).cnt;
    const percent = Math.round((receivedCount / upload.total_chunks) * 100);
    const bytesLoaded = db.prepare(
      'SELECT SUM(size_bytes) as total FROM upload_chunks WHERE upload_id = ?'
    ).get(uploadId).total || 0;
    broadcast('UPLOAD_PROGRESS', { uploadId, percent, bytesLoaded, totalSize: upload.total_size });

    return reply.send({ ok: true, chunkIndex, size, sha256: actualSha });
  });

  // ── Finalize upload ───────────────────────────────────────────────────────
  fastify.post('/upload/chunked/:uploadId/finalize', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { uploadId } = req.params;

    const db = getDb();
    const upload = db.prepare('SELECT * FROM uploads WHERE id = ? AND status = ?').get(uploadId, 'in_progress');
    if (!upload) return reply.code(404).send({ error: 'Upload not found or already finalized' });

    const received = db.prepare(
      'SELECT * FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index'
    ).all(uploadId);

    if (received.length !== upload.total_chunks) {
      const missing = [];
      for (let i = 0; i < upload.total_chunks; i++) {
        if (!received.find((c) => c.chunk_index === i)) missing.push(i);
      }
      return reply.code(400).send({ error: 'Missing chunks', missing });
    }

    // Verify all chunk files exist
    for (const chunk of received) {
      if (!fs.existsSync(chunkFile(uploadId, chunk.chunk_index))) {
        return reply.code(500).send({ error: `Chunk file missing: ${chunk.chunk_index}` });
      }
    }

    // Assemble + encrypt
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
            const buf = fs.readFileSync(chunkFile(uploadId, chunk.chunk_index));
            plainHasher.update(buf);
            encStream.write(buf);
          }
          encStream.end();
        })().catch(reject);
      });
    } catch (err) {
      fs.unlink(outPath, () => {});
      req.log.error(err, 'finalize encrypt failed');
      return reply.code(500).send({ error: 'Assembly failed' });
    }

    if (!keydata) {
      fs.unlink(outPath, () => {});
      return reply.code(500).send({ error: 'Encryption key not generated' });
    }

    const actualSha = plainHasher.digest('hex');
    if (actualSha !== upload.sha256_expected) {
      fs.unlink(outPath, () => {});
      return reply.code(422).send({
        error: 'File SHA-256 mismatch',
        expected: upload.sha256_expected,
        actual: actualSha,
      });
    }

    const totalSize = received.reduce((s, c) => s + c.size_bytes, 0);
    const expiryMs = EXPIRY_OPTIONS[upload.expires_in] ?? EXPIRY_OPTIONS['24h'];
    const now = Date.now();
    const expiresAt = now + expiryMs;

    const { ciphertext: encName, iv: nameIv, tag: nameTag } = encryptFilename(upload.original_name.trim(), fileId);

    db.prepare(`
      INSERT INTO files
        (id, storage_id, original_name, original_name_iv, mime_type, size_bytes, sha256,
         encryption_iv, encryption_tag, expires_at, created_at, download_count, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'complete')
    `).run(
      fileId, storageId, encName, nameIv, upload.mime_type, totalSize, actualSha,
      keydata.salt + ':' + keydata.iv, keydata.tag + ':' + nameTag,
      expiresAt, now,
    );

    db.prepare(`
      INSERT INTO transfer_history (id, event_type, file_id, size_bytes, ip_hash, timestamp, metadata)
      VALUES (?,?,?,?,?,?,?)
    `).run(uuidv4(), 'upload', fileId, totalSize, ipHash(req.ip), now,
      JSON.stringify({ method: 'chunked', chunks: upload.total_chunks }));

    // Cleanup: mark upload done, delete chunk files
    db.prepare("UPDATE uploads SET status = 'complete', updated_at = ? WHERE id = ?").run(now, uploadId);

    try {
      const dir = chunkDir(uploadId);
      fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f)));
      fs.rmdirSync(dir);
    } catch { /* non-fatal */ }

    // Decrypt original filename for response
    let filename = upload.original_name;
    try {
      filename = decryptFilename(encName, nameIv, nameTag, fileId);
    } catch { /* fallback */ }

    broadcast('UPLOAD_COMPLETE', {
      uploadId,
      fileId,
      filename,
      size: totalSize,
      downloadUrl: `/api/files/${fileId}/download`,
    });

    return reply.code(201).send({
      fileId,
      filename,
      size: totalSize,
      sha256: actualSha,
      expires_at: expiresAt,
      downloadUrl: `/api/files/${fileId}/download`,
    });
  });

  // ── Abort upload ──────────────────────────────────────────────────────────
  fastify.delete('/upload/chunked/:uploadId', async (req, reply) => {
    const { uploadId } = req.params;

    const db = getDb();
    const upload = db.prepare('SELECT id FROM uploads WHERE id = ?').get(uploadId);
    if (!upload) return reply.code(404).send({ error: 'Upload not found' });

    db.prepare("UPDATE uploads SET status = 'aborted', updated_at = ? WHERE id = ?").run(Date.now(), uploadId);

    try {
      const dir = chunkDir(uploadId);
      if (fs.existsSync(dir)) {
        fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f)));
        fs.rmdirSync(dir);
      }
    } catch { /* non-fatal */ }

    return reply.send({ ok: true });
  });

  // ── Upload status (for resume) ────────────────────────────────────────────
  fastify.get('/upload/chunked/:uploadId/status', async (req, reply) => {
    const { uploadId } = req.params;

    const db = getDb();
    const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId);
    if (!upload) return reply.code(404).send({ error: 'Upload not found' });

    const received = db.prepare(
      'SELECT chunk_index FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index'
    ).all(uploadId).map((r) => r.chunk_index);

    return reply.send({
      uploadId,
      status: upload.status,
      totalChunks: upload.total_chunks,
      receivedChunks: received,
    });
  });
}

module.exports = chunksRoutes;
