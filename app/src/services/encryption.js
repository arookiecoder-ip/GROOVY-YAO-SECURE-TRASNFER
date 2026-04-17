const crypto = require('crypto');
const { Transform } = require('stream');
const { config } = require('../config');

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT_LEN = 16;

function deriveMasterKey() {
  const masterSecret = Buffer.from(config.masterSecret, 'hex');
  // HKDF-Extract: HMAC(salt, ikm)
  const salt = Buffer.from('filetransfer-v1', 'utf8');
  const prk = crypto.createHmac('sha256', salt).update(masterSecret).digest();
  // HKDF-Expand
  const info = Buffer.from('file-encryption', 'utf8');
  const okm = hkdfExpand(prk, info, KEY_LEN);
  return okm;
}

function deriveFileKey(fileUuid) {
  const masterKey = deriveMasterKey();
  const salt = crypto.randomBytes(SALT_LEN);
  const info = Buffer.from(fileUuid, 'utf8');
  const key = hkdfExpand(
    crypto.createHmac('sha256', salt).update(masterKey).digest(),
    info,
    KEY_LEN,
  );
  return { key, salt };
}

function deriveFileKeyFromSalt(fileUuid, saltHex) {
  const masterKey = deriveMasterKey();
  const salt = Buffer.from(saltHex, 'hex');
  const info = Buffer.from(fileUuid, 'utf8');
  const key = hkdfExpand(
    crypto.createHmac('sha256', salt).update(masterKey).digest(),
    info,
    KEY_LEN,
  );
  return key;
}

function hkdfExpand(prk, info, length) {
  const n = Math.ceil(length / 32);
  const okm = Buffer.alloc(length);
  let prev = Buffer.alloc(0);
  for (let i = 1; i <= n; i++) {
    const hmac = crypto.createHmac('sha256', prk);
    hmac.update(prev);
    hmac.update(info);
    hmac.update(Buffer.from([i]));
    prev = hmac.digest();
    prev.copy(okm, (i - 1) * 32);
  }
  return okm;
}

function encryptBuffer(plaintext, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decryptBuffer(ciphertextB64, ivB64, tagB64, key) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted;
}

function encryptFilename(name, fileUuid) {
  const masterKey = deriveMasterKey();
  const info = Buffer.from(`filename:${fileUuid}`, 'utf8');
  const key = hkdfExpand(masterKey, info, KEY_LEN);
  return encryptBuffer(Buffer.from(name, 'utf8'), key);
}

function decryptFilename(ciphertextB64, ivB64, tagB64, fileUuid) {
  const masterKey = deriveMasterKey();
  const info = Buffer.from(`filename:${fileUuid}`, 'utf8');
  const key = hkdfExpand(masterKey, info, KEY_LEN);
  return decryptBuffer(ciphertextB64, ivB64, tagB64, key).toString('utf8');
}

function encryptTotpSecret(secret) {
  const masterKey = deriveMasterKey();
  const info = Buffer.from('totp-secret', 'utf8');
  const key = hkdfExpand(masterKey, info, KEY_LEN);
  return encryptBuffer(Buffer.from(secret, 'utf8'), key);
}

function decryptTotpSecret(ciphertextB64, ivB64, tagB64) {
  const masterKey = deriveMasterKey();
  const info = Buffer.from('totp-secret', 'utf8');
  const key = hkdfExpand(masterKey, info, KEY_LEN);
  return decryptBuffer(ciphertextB64, ivB64, tagB64, key).toString('utf8');
}

/**
 * Returns a Transform stream that encrypts data with AES-256-GCM.
 * Emits 'keydata' event with { key, salt, iv, tag } after stream finishes.
 * IV is prepended to output stream: [12-byte IV][ciphertext][16-byte tag]
 */
function createEncryptStream(fileUuid) {
  const { key, salt } = deriveFileKey(fileUuid);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let headerWritten = false;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      if (!headerWritten) {
        this.push(iv);
        headerWritten = true;
      }
      callback(null, cipher.update(chunk));
    },
    flush(callback) {
      const final = cipher.final();
      if (final.length) this.push(final);
      const tag = cipher.getAuthTag();
      this.push(tag);
      this.emit('keydata', { key, salt: salt.toString('hex'), iv: iv.toString('base64'), tag: tag.toString('base64') });
      callback();
    },
  });

  return transform;
}

/**
 * Returns a Transform stream that decrypts AES-256-GCM data.
 * Expects stream format: [12-byte IV][ciphertext][16-byte tag]
 */
function createDecryptStream(fileUuid, saltHex) {
  const key = deriveFileKeyFromSalt(fileUuid, saltHex);

  let ivBuffer = Buffer.alloc(0);
  let ivReady = false;
  let decipher = null;
  const chunks = [];

  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      if (!ivReady) {
        ivBuffer = Buffer.concat([ivBuffer, chunk]);
        if (ivBuffer.length >= IV_LEN) {
          const iv = ivBuffer.subarray(0, IV_LEN);
          const rest = ivBuffer.subarray(IV_LEN);
          decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
          ivReady = true;
          if (rest.length > 0) chunks.push(rest);
        }
      } else {
        chunks.push(chunk);
      }
      callback();
    },
    flush(callback) {
      if (!decipher) return callback(new Error('Stream ended before IV was read'));

      // Last TAG_LEN bytes are the GCM auth tag
      const allData = Buffer.concat(chunks);
      if (allData.length < TAG_LEN) return callback(new Error('Ciphertext too short'));

      const ciphertext = allData.subarray(0, allData.length - TAG_LEN);
      const tag = allData.subarray(allData.length - TAG_LEN);

      decipher.setAuthTag(tag);
      try {
        const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        this.push(plain);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });

  return transform;
}

module.exports = {
  deriveMasterKey,
  deriveFileKey,
  deriveFileKeyFromSalt,
  hkdfExpand,
  encryptBuffer,
  decryptBuffer,
  encryptFilename,
  decryptFilename,
  encryptTotpSecret,
  decryptTotpSecret,
  createEncryptStream,
  createDecryptStream,
};
