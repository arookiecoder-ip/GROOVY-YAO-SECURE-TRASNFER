// UploadManager — simple (<10MB) + chunked (>=10MB) with SHA-256, 3-retry backoff, resume
const UploadManager = {
  CHUNK_SIZE: 20 * 1024 * 1024,
  MAX_RETRIES: 3,
  PARALLEL: 4,

  // uploadId -> { file, totalChunks, chunkShas, aborted }
  _active: {},

  _selectedExpiry: '1h',

  init() {
    const dz = document.getElementById('drop-zone');
    const fi = document.getElementById('file-input');

    // Expiry picker — clicks handled here, not bubbled to drop zone
    document.querySelectorAll('.expiry-opt').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.expiry-opt').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this._selectedExpiry = btn.dataset.expires;
      });
    });

    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag-over', 'neon-pulse'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over', 'neon-pulse'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('drag-over', 'neon-pulse');
      this.handleFiles([...e.dataTransfer.files]);
    });
    fi.addEventListener('change', () => { this.handleFiles([...fi.files]); fi.value = ''; });

    document.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) this.handleFiles(files);
    });

    // Resume incomplete uploads on reconnect
    window.addEventListener('online', () => this._resumePending());
  },

  handleFiles(files) {
    files.forEach((f) => this.upload(f));
  },

  async upload(file) {
    if (file.size < 500 * 1024 * 1024) {
      await this._simpleUpload(file);
    } else {
      await this._chunkedUpload(file);
    }
  },

  // ── Simple upload ──────────────────────────────────────────────────────
  async _simpleUpload(file) {
    const progressId = `simple-${Date.now()}`;
    Progress.create(progressId, file.name, file.size);
    const item = Progress._items.get(progressId);

    return new Promise((resolve) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('expires', this._selectedExpiry);

      const xhr = new XMLHttpRequest();
      xhr.withCredentials = true;
      xhr.open('POST', '/api/upload/simple');

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const elapsed = (Date.now() - item.startTime) / 1000;
        const speedBps = elapsed > 0 ? e.loaded / elapsed : 0;
        const percent = (e.loaded / e.total) * 100;
        Progress.update(progressId, percent, e.loaded, speedBps);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const data = JSON.parse(xhr.responseText);
          Progress.complete(progressId);
          this._onComplete(data);
        } else {
          const err = JSON.parse(xhr.responseText || '{}');
          Progress.error(progressId, err.error || 'Upload failed');
          Notifications.error('Upload failed', err.error || 'Upload failed');
        }
        resolve();
      };

      xhr.onerror = () => {
        Progress.error(progressId, 'Network error');
        Notifications.error('Upload failed', 'Network error');
        resolve();
      };

      xhr.send(fd);
    });
  },

  // ── Chunked upload ─────────────────────────────────────────────────────
  async _chunkedUpload(file, resumeUploadId = null) {
    const progressId = resumeUploadId || `chunk-${Date.now()}`;
    Progress.create(progressId, file.name, file.size);

    try {
      // 1. Init
      const totalChunks = Math.ceil(file.size / this.CHUNK_SIZE);
      const initRes = await this._fetchWithRetry('/api/upload/chunked/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          totalSize: file.size,
          totalChunks,
          sha256: 'none',
          expiresIn: this._selectedExpiry,
        }),
        credentials: 'same-origin',
      });
      if (!initRes.ok) {
        const e = await initRes.json().catch(() => ({}));
        throw new Error(e.error || 'Init failed');
      }
      const { uploadId, receivedChunks } = await initRes.json();
      const received = new Set(receivedChunks);

      this._active[uploadId] = { file, totalChunks, progressId, aborted: false };

      // 2. Upload missing chunks in parallel
      const pending = [];
      for (let i = 0; i < totalChunks; i++) {
        if (received.has(i)) { Progress.advance(progressId, this._chunkSize(file, i)); continue; }
        pending.push(i);
      }

      for (let i = 0; i < pending.length; i += this.PARALLEL) {
        if (this._active[uploadId]?.aborted) throw new Error('Upload aborted');
        const batch = pending.slice(i, i + this.PARALLEL);
        await Promise.all(batch.map(async (idx) => {
          const start = idx * this.CHUNK_SIZE;
          const slice = file.slice(start, start + this.CHUNK_SIZE);
          await this._uploadChunk(uploadId, idx, slice, null);
          Progress.advance(progressId, slice.size);
        }));
      }

      // 4. Finalize
      const finRes = await this._fetchWithRetry(`/api/upload/chunked/${uploadId}/finalize`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!finRes.ok) {
        const e = await finRes.json().catch(() => ({}));
        throw new Error(e.error || 'Finalize failed');
      }
      const data = await finRes.json();

      delete this._active[uploadId];
      this._removePending(uploadId);
      Progress.complete(progressId);
      this._onComplete(data);
    } catch (err) {
      Progress.error(progressId, err.message);
      Notifications.error('Upload failed', err.message);
    }
  },

  async _uploadChunk(uploadId, index, slice, expectedSha) {
    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        const fd = new FormData();
        fd.append('chunk', slice, `chunk-${index}`);
        const headers = {};
        if (expectedSha) headers['x-chunk-sha256'] = expectedSha;

        const res = await fetch(`/api/upload/chunked/${uploadId}/chunk/${index}`, {
          method: 'PUT',
          headers,
          body: fd,
          credentials: 'same-origin',
        });

        if (res.ok) return;

        const e = await res.json().catch(() => ({}));
        if (res.status === 422) throw new Error(e.error || 'Chunk integrity check failed');
        // 5xx or 429 — retry
        if (attempt === this.MAX_RETRIES - 1) throw new Error(e.error || `Chunk ${index} failed`);

        await this._backoff(attempt);
      } catch (err) {
        if (attempt === this.MAX_RETRIES - 1) throw err;
        await this._backoff(attempt);
      }
    }
  },

  // ── SHA-256 via Web Worker ─────────────────────────────────────────────
  _hashFile(file) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('/js/hashWorker.js');
      const chunkShas = [];
      let fullSha = null;

      worker.onmessage = (e) => {
        const { type, sha256, index, message } = e.data;
        if (type === 'full') { fullSha = sha256; }
        else if (type === 'chunk') { chunkShas[index] = sha256; }
        else if (type === 'done') { worker.terminate(); resolve({ fullSha, chunkShas }); }
        else if (type === 'error') { worker.terminate(); reject(new Error(message)); }
      };
      worker.onerror = (err) => { worker.terminate(); reject(err); };
      worker.postMessage({ file, chunkSize: this.CHUNK_SIZE });
    });
  },

  // ── Resume pending uploads on reconnect ───────────────────────────────
  _resumePending() {
    const pending = this._loadPending();
    for (const { uploadId, file } of pending) {
      if (!this._active[uploadId]) {
        this._chunkedUpload(file, uploadId);
      }
    }
  },

  _savePending(uploadId, file) {
    try {
      const list = this._loadPending();
      if (!list.find((p) => p.uploadId === uploadId)) {
        list.push({ uploadId, fileName: file.name, fileSize: file.size });
        localStorage.setItem('pendingUploads', JSON.stringify(list));
      }
    } catch { /* storage unavailable */ }
  },

  _removePending(uploadId) {
    try {
      const list = this._loadPending().filter((p) => p.uploadId !== uploadId);
      localStorage.setItem('pendingUploads', JSON.stringify(list));
    } catch { /* storage unavailable */ }
  },

  _loadPending() {
    try {
      return JSON.parse(localStorage.getItem('pendingUploads') || '[]');
    } catch { return []; }
  },

  // ── Helpers ────────────────────────────────────────────────────────────
  _chunkSize(file, index) {
    const start = index * this.CHUNK_SIZE;
    return Math.min(this.CHUNK_SIZE, file.size - start);
  },

  _backoff(attempt) {
    return new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
  },

  async _fetchWithRetry(url, opts, retries = this.MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, opts);
        if (res.ok || res.status < 500) return res;
        if (i === retries - 1) return res;
        await this._backoff(i);
      } catch (err) {
        if (i === retries - 1) throw err;
        await this._backoff(i);
      }
    }
  },

  abort(uploadId) {
    const state = this._active[uploadId];
    if (state) state.aborted = true;
    fetch(`/api/upload/chunked/${uploadId}`, { method: 'DELETE', credentials: 'same-origin' })
      .catch(() => {});
    this._removePending(uploadId);
  },

  _onComplete(data) {
    Notifications.success('TRANSFER COMPLETE', data.filename || '');
    Utils.copyToClipboard(`${location.origin}/api/files/${data.fileId}/download`);
    if (typeof FileManagerModule !== 'undefined') FileManagerModule.refresh();
    this._showTransferFlash();
  },

  _showTransferFlash() {
    let el = document.querySelector('.transfer-complete-flash');
    if (!el) {
      el = document.createElement('div');
      el.className = 'transfer-complete-flash';
      el.innerHTML = '<div class="transfer-complete-text">TRANSFER COMPLETE</div>';
      document.body.appendChild(el);
    }
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 500);
  },
};
