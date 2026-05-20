// FileManager — list/grid view, sort, expiry countdowns, multi-select
const FileManagerModule = {
  _files: [],
  _view: localStorage.getItem('fm-view') || 'list',
  _sort: localStorage.getItem('fm-sort') || 'date',
  _expiryInterval: null,
  _actionsAbort: null,

  // Multi-select state
  _selected: new Set(),   // Set of file IDs currently selected
  _bulkBar: null,         // reference to the floating bulk-action bar element

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

    // Create the floating bulk-action bar (hidden by default)
    this._ensureBulkBar();
  },

  // ── Bulk action bar ────────────────────────────────────────────────────────

  _ensureBulkBar() {
    if (document.getElementById('bulk-action-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'bulk-action-bar';
    bar.className = 'bulk-action-bar hidden';
    bar.innerHTML = `
      <div class="bulk-bar-info">
        <span class="bulk-count" id="bulk-count">0 selected</span>
        <button class="bulk-deselect" id="bulk-deselect" title="Clear selection">✕</button>
      </div>
      <div class="bulk-bar-actions">
        <button class="btn btn-ghost btn-sm bulk-btn" id="bulk-btn-download" title="Download selected files one by one">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M2 13h12"/></svg>
          DOWNLOAD ALL
        </button>
        <button class="btn btn-ghost btn-sm bulk-btn" id="bulk-btn-share" title="Create a single bundle link for all selected files">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="4" r="2"/><circle cx="4" cy="8" r="2"/><circle cx="12" cy="12" r="2"/><path d="M6 7l4-2M6 9l4 2"/></svg>
          CREATE BUNDLE
        </button>
        <button class="btn btn-danger btn-sm bulk-btn" id="bulk-btn-delete" title="Delete selected files">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9h8l1-9"/></svg>
          DELETE ALL
        </button>
      </div>
    `;
    document.body.appendChild(bar);
    this._bulkBar = bar;

    bar.querySelector('#bulk-deselect').addEventListener('click', () => this._clearSelection());
    bar.querySelector('#bulk-btn-download').addEventListener('click', () => this._bulkDownload());
    bar.querySelector('#bulk-btn-share').addEventListener('click', () => this._bulkShare());
    bar.querySelector('#bulk-btn-delete').addEventListener('click', () => this._bulkDelete());
  },

  _updateBulkBar() {
    const bar = document.getElementById('bulk-action-bar');
    if (!bar) return;
    const n = this._selected.size;
    if (n === 0) {
      bar.classList.add('hidden');
    } else {
      bar.classList.remove('hidden');
      bar.querySelector('#bulk-count').textContent = `${n} file${n !== 1 ? 's' : ''} selected`;
    }
  },

  _clearSelection() {
    this._selected.clear();
    // Uncheck all checkboxes and remove row highlights
    document.querySelectorAll('.fm-checkbox').forEach((cb) => { cb.checked = false; });
    document.querySelectorAll('.file-row-selected').forEach((el) => el.classList.remove('file-row-selected'));
    document.querySelectorAll('.file-card-selected').forEach((el) => el.classList.remove('file-card-selected'));
    this._updateBulkBar();
  },

  _toggleSelect(id) {
    if (this._selected.has(id)) {
      this._selected.delete(id);
    } else {
      this._selected.add(id);
    }
    this._updateBulkBar();
  },

  // ── Bulk operations ────────────────────────────────────────────────────────

  /**
   * Download selected files one by one automatically.
   * Uses a hidden <a> with a small delay between each to avoid browser blocking.
   */
  async _bulkDownload() {
    const ids = [...this._selected];
    if (ids.length === 0) return;

    Notifications.info(`DOWNLOADING ${ids.length} FILE${ids.length !== 1 ? 'S' : ''}`, 'Files will download one by one');

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const f = this._files.find((f) => f.id === id);
      const name = f ? f.name : id;

      // Create a temporary anchor and click it — browser handles the download
      const a = document.createElement('a');
      a.href = `/api/files/${id}/download`;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Wait between downloads so the browser doesn't block them as a popup storm
      if (i < ids.length - 1) {
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    Notifications.success('DOWNLOADS STARTED', `${ids.length} file${ids.length !== 1 ? 's' : ''} queued`);
  },

  /**
   * Create a single bundle link for all selected files.
   * One URL — recipient opens it and can download all files from one page.
   */
  async _bulkShare() {
    const ids = [...this._selected];
    if (ids.length === 0) return;

    const btn = document.getElementById('bulk-btn-share');
    const origText = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span style="opacity:.6">CREATING...</span>'; }

    try {
      const res = await Utils.apiFetch('/api/bundles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: ids }),
        credentials: 'same-origin',
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create bundle');
      }

      const { url } = await res.json();
      await Utils.copyToClipboard(url);
      Notifications.success(
        `BUNDLE LINK CREATED`,
        `${ids.length} file${ids.length !== 1 ? 's' : ''} — link copied to clipboard`
      );
    } catch (err) {
      Notifications.error('Bundle creation failed', err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = origText; }
    }
  },

  /**
   * Delete all selected files after confirmation.
   */
  async _bulkDelete() {
    const ids = [...this._selected];
    if (ids.length === 0) return;

    const confirmed = await Utils.confirm(
      `Delete ${ids.length} file${ids.length !== 1 ? 's' : ''}? This cannot be undone.`,
      'Delete All'
    );
    if (!confirmed) return;

    let deleted = 0;
    let failed = 0;

    for (const id of ids) {
      const res = await Utils.apiFetch(`/api/files/${id}`, { method: 'DELETE', credentials: 'same-origin' });
      if (res.ok) {
        deleted++;
        this._files = this._files.filter((f) => f.id !== id);
      } else {
        failed++;
      }
    }

    this._selected.clear();
    this._updateBulkBar();
    this._renderFiles();

    if (deleted > 0) Notifications.success(`${deleted} file${deleted !== 1 ? 's' : ''} deleted`);
    if (failed > 0) Notifications.error(`${failed} deletion${failed !== 1 ? 's' : ''} failed`);
  },

  // ── Rendering ──────────────────────────────────────────────────────────────

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
              <th class="col-check">
                <label class="fm-check-label" title="Select all">
                  <input type="checkbox" class="fm-checkbox fm-checkbox-all" aria-label="Select all files" />
                </label>
              </th>
              <th>NAME</th>
              <th>SIZE</th>
              <th>UPLOADED D&T</th>
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

      // Select-all checkbox
      const allCb = content.querySelector('.fm-checkbox-all');
      allCb.checked = this._selected.size === this._files.length && this._files.length > 0;
      allCb.indeterminate = this._selected.size > 0 && this._selected.size < this._files.length;
      allCb.addEventListener('change', () => {
        if (allCb.checked) {
          this._files.forEach((f) => this._selected.add(f.id));
        } else {
          this._selected.clear();
        }
        this._renderFiles();
        this._updateBulkBar();
      });
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

  _formatIST(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  },

  _actionBar(f) {
    const isPreviewable = f.mime_type && (f.mime_type.startsWith('image/') || f.mime_type === 'application/pdf');
    return `
      <button class="act-btn" data-action="download" data-id="${f.id}" title="Download">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M2 13h12"/></svg>
      </button>
      ${isPreviewable ? `
      <button class="act-btn" data-action="preview" data-id="${f.id}" data-mime="${f.mime_type}" data-name="${Utils.escape(f.name)}" title="Preview">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>
      </button>` : ''}
      <button class="act-btn${f.is_public ? '' : ' act-btn--disabled'}" data-action="${f.is_public ? 'qr' : ''}" data-id="${f.id}" title="${f.is_public ? 'QR Code' : 'Make public to share'}" ${f.is_public ? '' : 'disabled'}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="1" width="5" height="5" rx="0.5"/><rect x="10" y="1" width="5" height="5" rx="0.5"/><rect x="1" y="10" width="5" height="5" rx="0.5"/><rect x="2.5" y="2.5" width="2" height="2"/><rect x="11.5" y="2.5" width="2" height="2"/><rect x="2.5" y="11.5" width="2" height="2"/><path d="M10 10h2v2h-2zM12 12h3M12 10h3v2M10 12v3"/></svg>
      </button>
      ${this._visToggle(f)}
      <button class="act-btn" data-action="extend" data-id="${f.id}" title="Extend expiry">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2.5 1.5"/></svg>
      </button>
      <button class="act-btn act-btn--danger" data-action="delete" data-id="${f.id}" title="Delete">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9h8l1-9"/></svg>
      </button>
    `;
  },

  _listRow(f) {
    const cls = Utils.expiryClass(f.expires_at);
    const isSelected = this._selected.has(f.id);
    return `
      <tr class="${isSelected ? 'file-row-selected' : ''}">
        <td class="col-check">
          <label class="fm-check-label">
            <input type="checkbox" class="fm-checkbox" data-id="${f.id}" ${isSelected ? 'checked' : ''} aria-label="Select ${Utils.escape(f.name)}" />
          </label>
        </td>
        <td><span class="file-name" title="${Utils.escape(f.name)}">${Utils.escape(f.name)}</span></td>
        <td class="file-size">${Utils.formatBytes(f.size_bytes)}</td>
        <td class="file-size">${this._formatIST(f.created_at)}</td>
        <td class="file-expiry col-expiry ${cls}" data-expires="${f.expires_at || ''}">${Utils.formatExpiry(f.expires_at)}</td>
        <td class="file-size col-downloads">${f.download_count}</td>
        <td class="file-actions">${this._actionBar(f)}</td>
      </tr>
    `;
  },

  _gridCard(f) {
    const isSelected = this._selected.has(f.id);
    return `
      <div class="file-card ${isSelected ? 'file-card-selected' : ''}">
        <label class="fm-check-label fm-check-card">
          <input type="checkbox" class="fm-checkbox" data-id="${f.id}" ${isSelected ? 'checked' : ''} aria-label="Select ${Utils.escape(f.name)}" />
        </label>
        <div class="file-card-name" title="${Utils.escape(f.name)}">${Utils.escape(f.name)}</div>
        <div class="file-card-meta">${Utils.formatBytes(f.size_bytes)}</div>
        <div class="file-card-meta" style="font-size:0.7rem;color:var(--color-text-dim)">${this._formatIST(f.created_at)}</div>
        <div class="file-card-actions">${this._actionBar(f)}</div>
      </div>
    `;
  },

  _bindActions(root) {
    if (this._actionsAbort) this._actionsAbort.abort();
    this._actionsAbort = new AbortController();
    const sig = { signal: this._actionsAbort.signal };

    // Handle checkbox changes (individual row/card checkboxes)
    root.addEventListener('change', (e) => {
      const cb = e.target.closest('.fm-checkbox:not(.fm-checkbox-all)');
      if (!cb) return;
      const id = cb.dataset.id;
      if (!id) return;
      this._toggleSelect(id);
      // Highlight the row/card
      const row = cb.closest('tr');
      const card = cb.closest('.file-card');
      if (row) row.classList.toggle('file-row-selected', cb.checked);
      if (card) card.classList.toggle('file-card-selected', cb.checked);
      // Update select-all checkbox state
      const allCb = root.querySelector('.fm-checkbox-all');
      if (allCb) {
        allCb.checked = this._selected.size === this._files.length;
        allCb.indeterminate = this._selected.size > 0 && this._selected.size < this._files.length;
      }
    }, sig);

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
      } else if (action === 'preview') {
        this._showPreview(id, btn.dataset.mime, btn.dataset.name);
      } else if (action === 'copylink') {
        const f = this._files.find((f) => f.id === id);
        if (!f || !f.share_token) { Notifications.error('No public link — make file public first'); return; }
        Utils.copyToClipboard(`${location.origin}/api/files/s/${f.share_token}/download`);
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
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

  _showPreview(id, mime, name) {
    document.getElementById('file-preview-modal')?.remove();

    const isPdf = mime === 'application/pdf';
    const isImage = mime && mime.startsWith('image/');
    const previewUrl = `/api/files/${id}/preview`;

    const modal = document.createElement('div');
    modal.id = 'file-preview-modal';
    modal.className = 'preview-overlay';
    modal.innerHTML = `
      <div class="preview-box">
        <div class="preview-header">
          <span class="preview-title" title="${Utils.escape(name)}">${Utils.escape(name)}</span>
          <div class="preview-header-actions">
            <a href="/api/files/${id}/download" class="btn btn-ghost btn-sm" download="${Utils.escape(name)}" title="Download">⬇ DOWNLOAD</a>
            <button class="drawer-close" id="preview-close" aria-label="Close">✕</button>
          </div>
        </div>
        <div class="preview-body" id="preview-body">
          <div class="preview-loading">LOADING...</div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const body = modal.querySelector('#preview-body');

    if (isImage) {
      const img = document.createElement('img');
      img.className = 'preview-image';
      img.alt = name;
      img.onload = () => { body.innerHTML = ''; body.appendChild(img); };
      img.onerror = () => { body.innerHTML = '<div class="preview-error">Failed to load image</div>'; };
      img.src = previewUrl;
    } else if (isPdf) {
      body.innerHTML = `<iframe class="preview-pdf" src="${previewUrl}" title="${Utils.escape(name)}" allowfullscreen></iframe>`;
    }

    const close = () => modal.remove();
    modal.querySelector('#preview-close').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
  },

  async _toggleVisibility(id, currentlyPublic) {
    const isPublic = !currentlyPublic;
    const res = await Utils.apiFetch(`/api/files/${id}/visibility`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic }),
      credentials: 'same-origin',
    });
    if (res.ok) {
      const data = await res.json();
      const f = this._files.find((f) => f.id === id);
      if (f) { f.is_public = isPublic; f.share_token = data.shareToken || null; }
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

    document.body.appendChild(pop);
    const rect = anchorEl.getBoundingClientRect();
    const popW = pop.offsetWidth;
    const popH = pop.offsetHeight;
    const inGrid = !!anchorEl.closest('.file-card');
    if (inGrid) {
      let left = rect.right + 6;
      if (left + popW > window.innerWidth - 8) left = rect.left - popW - 6;
      let top = rect.top;
      if (top + popH > window.innerHeight - 8) top = window.innerHeight - popH - 8;
      if (top < 8) top = 8;
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
    } else {
      let left = rect.left;
      if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
      if (left < 8) left = 8;
      let top = rect.bottom + 6;
      if (top + popH > window.innerHeight - 8) top = rect.top - popH - 6;
      if (top < 8) top = 8;
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
    }

    const cleanup = () => pop.remove();

    pop.querySelectorAll('.expiry-pop-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        cleanup();
        const expiresIn = btn.dataset.val;
        const res = await Utils.apiFetch(`/api/files/${id}/expiry`, {
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

    setTimeout(() => document.addEventListener('click', function handler(e) {
      if (!pop.contains(e.target)) { cleanup(); document.removeEventListener('click', handler); }
    }), 0);
  },

  async _deleteFile(id) {
    const res = await Utils.apiFetch(`/api/files/${id}`, { method: 'DELETE', credentials: 'same-origin' });
    if (res.ok) {
      this._files = this._files.filter((f) => f.id !== id);
      this._selected.delete(id);
      this._renderFiles();
      this._updateBulkBar();
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
