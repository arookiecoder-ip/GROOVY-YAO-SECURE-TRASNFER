// FileManager — list/grid view, sort, expiry countdowns
const FileManagerModule = {
  _files: [],
  _view: localStorage.getItem('fm-view') || 'list',
  _sort: localStorage.getItem('fm-sort') || 'date',
  _expiryInterval: null,
  _actionsAbort: null,

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
        <button class="btn btn-ghost btn-sm" id="btn-sync" title="Sync files">⟳ SYNC</button>
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

    container.querySelector('#btn-sync').addEventListener('click', () => this.refresh());

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
        <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;width:100%;max-width:100%;">
        <table class="file-list">
          <thead>
            <tr>
              <th>NAME</th>
              <th>SIZE</th>
              <th class="col-expiry">EXPIRES</th>
              <th class="col-downloads">Downloads</th>
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

  _visToggle(f) {
    return `<button class="vis-toggle${f.is_public ? ' is-public' : ''}" data-action="visibility" data-id="${f.id}" data-public="${f.is_public}" title="${f.is_public ? 'Public — click to make private' : 'Private — click to make public'}">
      <span class="vis-toggle-knob"></span>
      <span class="vis-toggle-label">${f.is_public ? 'Public' : 'Private'}</span>
    </button>`;
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
          <button class="btn btn-ghost btn-sm" data-action="download"   data-id="${f.id}">Download</button>
          <button class="btn btn-ghost btn-sm" data-action="qr"         data-id="${f.id}">QR Code</button>
          ${this._visToggle(f)}
          <button class="btn btn-ghost btn-sm" data-action="extend"     data-id="${f.id}">Extend</button>
          <button class="btn btn-danger btn-sm" data-action="delete"    data-id="${f.id}">Delete</button>
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
          <button class="btn btn-ghost btn-sm" data-action="download"   data-id="${f.id}">Download</button>
          <button class="btn btn-ghost btn-sm" data-action="qr"         data-id="${f.id}">QR Code</button>
          ${this._visToggle(f)}
          <button class="btn btn-ghost btn-sm" data-action="extend"     data-id="${f.id}">Extend</button>
          <button class="btn btn-danger btn-sm" data-action="delete"    data-id="${f.id}">Delete</button>
        </div>
      </div>
    `;
  },

  _bindActions(root) {
    if (this._actionsAbort) this._actionsAbort.abort();
    this._actionsAbort = new AbortController();
    const sig = { signal: this._actionsAbort.signal };

    root.addEventListener('mousedown', (e) => {
      const btn = e.target.closest('[data-action="visibility"]');
      if (btn) e.preventDefault();
    }, sig);
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const { action, id } = btn.dataset;
      if (action === 'download') {
        window.location.href = `/api/files/${id}/download`;
      } else if (action === 'qr') {
        QRModule.show(id);
      } else if (action === 'visibility') {
        btn.blur();
        await this._toggleVisibility(id, btn.dataset.public === 'true');
      } else if (action === 'extend') {
        if (document.getElementById('expiry-popover')) { document.getElementById('expiry-popover').remove(); return; }
        this._extendExpiry(id, btn);
      } else if (action === 'delete') {
        if (!await Utils.confirm('Delete this file?', 'Delete')) return;
        await this._deleteFile(id);
      }
    }, sig);
  },

  async _toggleVisibility(id, currentlyPublic) {
    const isPublic = !currentlyPublic;
    const res = await fetch(`/api/files/${id}/visibility`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic }),
      credentials: 'same-origin',
    });
    if (res.ok) {
      const f = this._files.find((f) => f.id === id);
      if (f) f.is_public = isPublic;
      // Update only the toggle buttons in-place — no full re-render, no scroll jump
      document.querySelectorAll(`.vis-toggle[data-id="${id}"]`).forEach((btn) => {
        btn.dataset.public = String(isPublic);
        btn.classList.toggle('is-public', isPublic);
        btn.title = isPublic ? 'Public — click to make private' : 'Private — click to make public';
        const label = btn.querySelector('.vis-toggle-label');
        if (label) label.textContent = isPublic ? 'Public' : 'Private';
      });
      Notifications.success(isPublic ? 'File is now public' : 'File is now private');
    } else {
      Notifications.error('Visibility change failed');
    }
  },

  _extendExpiry(id, anchorEl) {
    // Remove any existing popover
    document.getElementById('expiry-popover')?.remove();

    const opts = [
      { label: '+1H',  value: '1h' },
      { label: '+6H',  value: '6h' },
      { label: '+24H', value: '24h' },
      { label: '+7D',  value: '7d' },
      { label: '+30D', value: '30d' },
      { label: '∞ NEVER', value: 'never' },
    ];

    const pop = document.createElement('div');
    pop.id = 'expiry-popover';
    pop.className = 'expiry-popover';
    pop.innerHTML = `
      <div class="expiry-pop-title">// SET EXPIRY</div>
      <div class="expiry-pop-opts">
        ${opts.map(o => `<button class="expiry-pop-btn" data-val="${o.value}">${o.label}</button>`).join('')}
      </div>
    `;

    // Position near the anchor button
    document.body.appendChild(pop);
    const rect = anchorEl.getBoundingClientRect();
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;
    const inGrid = !!anchorEl.closest('.file-card');
    if (inGrid) {
      // Place to the right of the card
      let left = rect.right + window.scrollX + 6;
      if (left + popW > window.innerWidth - 8) left = rect.left + window.scrollX - popW - 6;
      let top = rect.top + window.scrollY;
      if (top + popH > window.innerHeight + window.scrollY - 8) top = window.innerHeight + window.scrollY - popH - 8;
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
    } else {
      let left = rect.left + window.scrollX;
      if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
      pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
      pop.style.left = `${left}px`;
    }

    const cleanup = () => pop.remove();

    pop.querySelectorAll('.expiry-pop-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        cleanup();
        const expiresIn = btn.dataset.val;
        const res = await fetch(`/api/files/${id}/expiry`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresIn }),
          credentials: 'same-origin',
        });
        if (res.ok) {
          Notifications.success('Expiry updated');
          this.refresh();
        } else {
          Notifications.error('Extend failed');
        }
      });
    });

    // Close on outside click
    setTimeout(() => document.addEventListener('click', function handler(e) {
      if (!pop.contains(e.target)) { cleanup(); document.removeEventListener('click', handler); }
    }), 0);
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
