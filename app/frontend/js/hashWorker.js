// SHA-256 Web Worker — streams file slice-by-slice to avoid blocking main thread
self.onmessage = async (e) => {
  const { file, chunkSize } = e.data;
  const SLICE = chunkSize || 5 * 1024 * 1024;

  try {
    // Full-file SHA-256
    const fullHasher = await computeSha256(file);
    self.postMessage({ type: 'full', sha256: fullHasher });

    // Per-chunk SHA-256
    let offset = 0;
    let index = 0;
    while (offset < file.size) {
      const slice = file.slice(offset, offset + SLICE);
      const sha256 = await computeSha256(slice);
      self.postMessage({ type: 'chunk', index, sha256 });
      offset += SLICE;
      index++;
    }

    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

async function computeSha256(blobOrFile) {
  const buf = await blobOrFile.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
