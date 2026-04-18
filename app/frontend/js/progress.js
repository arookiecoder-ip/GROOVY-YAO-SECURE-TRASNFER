// CyberpunkProgressBar — manages upload item UI in the queue
const Progress = {
  _items: new Map(),

  create(uploadId, filename, totalBytes) {
    const queue = document.getElementById('upload-queue');
    queue.classList.remove('hidden');

    const el = document.createElement('div');
    el.className = 'upload-item';
    el.id = `upload-${uploadId}`;
    el.innerHTML = `
      <div class="upload-item-header">
        <span class="upload-item-name">${Utils.escape(filename)}</span>
        <span class="upload-item-status" id="status-${uploadId}">INITIALIZING...</span>
        <button class="upload-cancel-btn" id="cancel-${uploadId}" title="Cancel upload">✕</button>
      </div>
      <div class="progress-track">
        <div class="progress-fill" id="fill-${uploadId}" style="width:0%"></div>
      </div>
      <div class="upload-item-meta">
        <span class="upload-speed" id="speed-${uploadId}">-- MB/s</span>
        <span class="upload-eta"  id="eta-${uploadId}">ETA: --</span>
      </div>
    `;
    queue.appendChild(el);
    this._items.set(uploadId, { el, totalBytes, startTime: Date.now(), bytesLoaded: 0 });

    el.querySelector(`#cancel-${uploadId}`).addEventListener('click', () => {
      UploadManager.abort(uploadId);
      this.cancelled(uploadId);
    });

    return el;
  },

  update(uploadId, percent, bytesDone, speedBps) {
    const item = this._items.get(uploadId);
    if (!item) return;
    document.getElementById(`fill-${uploadId}`).style.width = `${percent}%`;
    document.getElementById(`status-${uploadId}`).textContent = `${percent.toFixed(0)}%`;
    if (speedBps > 0) {
      document.getElementById(`speed-${uploadId}`).textContent = `${Utils.formatBytes(speedBps)}/s`;
      const remaining = (item.totalBytes - bytesDone) / speedBps;
      document.getElementById(`eta-${uploadId}`).textContent = `ETA: ${Utils.formatEta(remaining)}`;
    }
  },

  complete(uploadId) {
    const item = this._items.get(uploadId);
    if (!item) return;
    document.getElementById(`fill-${uploadId}`).style.width = '100%';
    document.getElementById(`status-${uploadId}`).textContent = 'COMPLETE';
    document.getElementById(`speed-${uploadId}`).textContent = '';
    document.getElementById(`eta-${uploadId}`).textContent = '';
    item.el.style.borderColor = 'var(--color-cyan)';
    document.getElementById(`cancel-${uploadId}`)?.remove();
    setTimeout(() => {
      item.el.remove();
      this._items.delete(uploadId);
      if (this._items.size === 0) document.getElementById('upload-queue').classList.add('hidden');
    }, 2000);
  },

  // Called by upload.js to track bytes as chunks complete locally
  advance(uploadId, bytes) {
    const item = this._items.get(uploadId);
    if (!item) return;
    item.bytesLoaded = (item.bytesLoaded || 0) + bytes;
    const elapsed = (Date.now() - item.startTime) / 1000;
    const speedBps = elapsed > 0 ? item.bytesLoaded / elapsed : 0;
    const percent = item.totalBytes > 0 ? (item.bytesLoaded / item.totalBytes) * 100 : 0;
    this.update(uploadId, percent, item.bytesLoaded, speedBps);
  },

  error(uploadId, msg) {
    const item = this._items.get(uploadId);
    if (!item) return;
    document.getElementById(`status-${uploadId}`).textContent = `ERROR: ${msg}`;
    item.el.style.borderColor = 'var(--color-red)';
    document.getElementById(`cancel-${uploadId}`)?.remove();
  },

  cancelled(uploadId) {
    const item = this._items.get(uploadId);
    if (!item) return;
    document.getElementById(`status-${uploadId}`).textContent = 'CANCELLED';
    item.el.style.borderColor = 'var(--color-red)';
    document.getElementById(`cancel-${uploadId}`)?.remove();
    setTimeout(() => {
      item.el.remove();
      this._items.delete(uploadId);
      if (this._items.size === 0) document.getElementById('upload-queue').classList.add('hidden');
    }, 1500);
  },
};
