// UploadManager — simple (<=50MB) + chunked (>50MB) with SHA-256, 3-retry backoff, resume
const UploadManager = {
  CHUNK_SIZE: 64 * 1024 * 1024,
  MAX_RETRIES: 3,
  PARALLEL: 3,

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

    window.addEventListener('beforeunload', (e) => {
      if (Object.keys(this._active).length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  },

  handleFiles(files) {
    files.forEach((f) => this.upload(f));
  },

  async upload(file) {
    if (file.size <= 50 * 1024 * 1024) {
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

      this._active[progressId] = { aborted: false, xhr, progressId };

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const elapsed = (Date.now() - item.startTime) / 1000;
        const speedBps = elapsed > 0 ? e.loaded / elapsed : 0;
        const percent = (e.loaded / e.total) * 100;
        Progress.update(progressId, percent, e.loaded, speedBps);
      };

      xhr.onload = () => {
        delete this._active[progressId];
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
        delete this._active[progressId];
        Progress.error(progressId, 'Network error');
        Notifications.error('Upload failed', 'Network error');
        resolve();
      };

      xhr.onabort = () => {
        delete this._active[progressId];
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

      this._active[uploadId] = { file, totalChunks, progressId, serverUploadId: uploadId, aborted: false };
      this._active[progressId] = this._active[uploadId];

      // 2. Upload missing chunks — sliding window with live per-chunk XHR progress
      const pending = [];
      const chunkProgress = new Array(totalChunks).fill(0);
      const startTime = Date.now();

      for (let i = 0; i < totalChunks; i++) {
        if (received.has(i)) { chunkProgress[i] = this._chunkSize(file, i); continue; }
        pending.push(i);
      }

      const onChunkProgress = (idx, loaded) => {
        chunkProgress[idx] = loaded;
        const totalLoaded = chunkProgress.reduce((a, b) => a + b, 0);
        const elapsed = (Date.now() - startTime) / 1000;
        const speedBps = elapsed > 0.5 ? totalLoaded / elapsed : 0;
        const percent = Math.min(99, (totalLoaded / file.size) * 100);
        Progress.update(progressId, percent, totalLoaded, speedBps);
      };

      let next = 0;
      const worker = async () => {
        while (next < pending.length) {
          if (this._active[uploadId]?.aborted) throw new Error('Upload aborted');
          const idx = pending[next++];
          const start = idx * this.CHUNK_SIZE;
          const slice = file.slice(start, start + this.CHUNK_SIZE);
          await this._uploadChunk(uploadId, idx, slice, null, (loaded) => onChunkProgress(idx, loaded));
          chunkProgress[idx] = slice.size;
        }
      };
      await Promise.all(Array.from({ length: this.PARALLEL }, worker));

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
      delete this._active[progressId];
      this._removePending(uploadId);
      Progress.complete(progressId);
      this._onComplete(data);
    } catch (err) {
      Progress.error(progressId, err.message);
      Notifications.error('Upload failed', err.message);
    }
  },

  async _uploadChunk(uploadId, index, slice, expectedSha, onProgress) {
    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        await new Promise((resolve, reject) => {
          const fd = new FormData();
          fd.append('chunk', slice, `chunk-${index}`);
          const xhr = new XMLHttpRequest();
          xhr.withCredentials = true;
          if (expectedSha) xhr.setRequestHeader('x-chunk-sha256', expectedSha);
          xhr.open('PUT', `/api/upload/chunked/${uploadId}/chunk/${index}`);
          xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded); };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
            const e = JSON.parse(xhr.responseText || '{}');
            reject(Object.assign(new Error(e.error || `Chunk ${index} failed`), { status: xhr.status }));
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.send(fd);

          const state = this._active[uploadId];
          if (state) state._lastXhr = xhr;
        });
        return;
      } catch (err) {
        if (err.status === 422) throw err;
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
    if (!state) return;
    state.aborted = true;
    const serverUploadId = state.serverUploadId || uploadId;
    if (state.xhr) {
      state.xhr.abort();
    } else {
      if (state._lastXhr) state._lastXhr.abort();
      fetch(`/api/upload/chunked/${serverUploadId}`, { method: 'DELETE', credentials: 'same-origin' })
        .catch(() => {});
    }
    delete this._active[serverUploadId];
    delete this._active[state.progressId];
    this._removePending(serverUploadId);
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
