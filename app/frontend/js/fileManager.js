// FileManager — list/grid view, sort, expiry countdowns
const FileManagerModule = {
  _files: [],
  _view: localStorage.getItem('fm-view') || 'list',
  _sort: localStorage.getItem('fm-sort') || 'date',
  _expiryInterval: null,

  init() {
    this._render();
    this.refresh();
  },

  async refresh() {
    try {
      const res = await fetch(`/api/files?sort=${this._sort}`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      this._files = data.files || data;
      this._renderFiles();
    } catch { /* network error — silent */ }
  },

  _render() {
    const container = document.getElementById('view-files');
    container.innerHTML = `
      <div class="file-manager-toolbar">
        <div class="view-toggle">
          <button class="view-toggle-btn ${this._view === 'list' ? 'active' : ''}" data-v="list">≡ LIST</button>
          <button class="view-toggle-btn ${this._view === 'grid' ? 'active' : ''}" data-v="grid">⊞ GRID</button>
        </div>
        <div class="sort-group">
          <button class="sort-btn ${this._sort === 'date' ? 'active' : ''}" data-s="date">DATE</button>
          <button class="sort-btn ${this._sort === 'name' ? 'active' : ''}" data-s="name">NAME</button>
          <button class="sort-btn ${this._sort === 'size' ? 'active' : ''}" data-s="size">SIZE</button>
        </div>
      </div>
      <div id="files-content"></div>
    `;

    container.querySelectorAll('.view-toggle-btn').forEach((b) => {
      b.addEventListener('click', () => {
        this._view = b.dataset.v;
        localStorage.setItem('fm-view', this._view);
        container.querySelectorAll('.view-toggle-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        this._renderFiles();
      });
    });

    container.querySelectorAll('.sort-btn').forEach((b) => {
      b.addEventListener('click', () => {
        this._sort = b.dataset.s;
        localStorage.setItem('fm-sort', this._sort);
        container.querySelectorAll('.sort-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        this.refresh();
      });
    });
  },

  _renderFiles() {
    const content = document.getElementById('files-content');
    if (!content) return;

    if (this._files.length === 0) {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⬡</div><div class="empty-state-text">NO FILES — DROP SOMETHING</div></div>`;
      return;
    }

    if (this._view === 'list') {
      content.innerHTML = `
        <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">
        <table class="file-list">
          <thead>
            <tr>
              <th>NAME</th>
              <th>SIZE</th>
              <th class="col-expiry">EXPIRES</th>
              <th class="col-downloads">DL</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            ${this._files.map((f) => this._listRow(f)).join('')}
          </tbody>
        </table>
        </div>
      `;
    } else {
      content.innerHTML = `<div class="file-grid">${this._files.map((f) => this._gridCard(f)).join('')}</div>`;
    }

    this._bindActions(content);
    this._startExpiryCountdown(content);
  },

  _listRow(f) {
    const cls = Utils.expiryClass(f.expires_at);
    return `
      <tr>
        <td><span class="file-name" title="${Utils.escape(f.name)}">${Utils.escape(f.name)}</span></td>
        <td class="file-size">${Utils.formatBytes(f.size_bytes)}</td>
        <td class="file-expiry col-expiry ${cls}" data-expires="${f.expires_at || ''}">${Utils.formatExpiry(f.expires_at)}</td>
        <td class="file-size col-downloads">${f.download_count}</td>
        <td class="file-actions">
          <button class="btn btn-ghost btn-sm" data-action="download" data-id="${f.id}">DL</button>
          <button class="btn btn-ghost btn-sm" data-action="qr"       data-id="${f.id}">QR</button>
          <button class="btn btn-ghost btn-sm" data-action="extend"   data-id="${f.id}">+EXP</button>
          <button class="btn btn-danger btn-sm" data-action="delete"  data-id="${f.id}">DEL</button>
        </td>
      </tr>
    `;
  },

  _gridCard(f) {
    return `
      <div class="file-card">
        <div class="file-card-name" title="${Utils.escape(f.name)}">${Utils.escape(f.name)}</div>
        <div class="file-card-meta">${Utils.formatBytes(f.size_bytes)}</div>
        <div class="file-card-actions">
          <button class="btn btn-ghost btn-sm" data-action="download" data-id="${f.id}">DL</button>
          <button class="btn btn-ghost btn-sm" data-action="qr"       data-id="${f.id}">QR</button>
          <button class="btn btn-ghost btn-sm" data-action="extend"   data-id="${f.id}">+EXP</button>
          <button class="btn btn-danger btn-sm" data-action="delete"  data-id="${f.id}">DEL</button>
        </div>
      </div>
    `;
  },

  _bindActions(root) {
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const { action, id } = btn.dataset;
      if (action === 'download') {
        window.location.href = `/api/files/${id}/download`;
      } else if (action === 'qr') {
        QRModule.show(id);
      } else if (action === 'extend') {
        await this._extendExpiry(id);
      } else if (action === 'delete') {
        if (!confirm('Delete this file?')) return;
        await this._deleteFile(id);
      }
    });
  },

  async _extendExpiry(id) {
    const expiresIn = prompt('Extend by: 1h / 6h / 24h / 7d / 30d', '24h');
    if (!expiresIn) return;
    const res = await fetch(`/api/files/${id}/expiry`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
      credentials: 'same-origin',
    });
    if (res.ok) {
      Notifications.success('Expiry extended');
      this.refresh();
    } else {
      Notifications.error('Extend failed');
    }
  },

  async _deleteFile(id) {
    const res = await fetch(`/api/files/${id}`, { method: 'DELETE', credentials: 'same-origin' });
    if (res.ok) {
      this._files = this._files.filter((f) => f.id !== id);
      this._renderFiles();
      Notifications.success('File deleted');
    } else {
      Notifications.error('Delete failed');
    }
  },

  _startExpiryCountdown(root) {
    clearInterval(this._expiryInterval);
    this._expiryInterval = setInterval(() => {
      root.querySelectorAll('[data-expires]').forEach((el) => {
        const ts = parseInt(el.dataset.expires, 10);
        if (!ts) return;
        el.textContent = Utils.formatExpiry(ts);
        el.className = `file-expiry ${Utils.expiryClass(ts)}`;
      });
    }, 10000);
  },
};
