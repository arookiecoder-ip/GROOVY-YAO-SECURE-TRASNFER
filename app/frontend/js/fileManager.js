// FileManager — list/grid view, sort, expiry countdowns, multi-select, pagination
const FileManagerModule = {
  _files: [],
  _view: localStorage.getItem('fm-view') || 'list',
  _sort: localStorage.getItem('fm-sort') || 'date',
  _search: '',
  _actionsAbort: null,

  // Pagination state
  _page: 1,
  _perPage: parseInt(localStorage.getItem('fm-perpage') || '25', 10),

  // Multi-select state
  _selected: new Set(),
  _bulkBar: null,

  // Drag-to-select state (rubber-band / lasso style like Google Drive)
  _dragSelect: {
    active: false,
    startX: 0,
    startY: 0,
    rect: null,           // the visual lasso <div>
    preSelected: null,    // Set of ids selected BEFORE drag started
    container: null,      // the files-content element
    _dragging: false,     // true only after mouse moves beyond threshold
    _additive: false,
    _lastAdditive: false,
  },

  init() {
    this._render();
    this.refresh();
  },

  async refresh() {
    try {
      // Fetch all files at once — pagination is handled client-side
      const res = await fetch(`/api/files?sort=${this._sort}&limit=200`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      this._files = data.files || data;
      this._page = 1; // reset to first page on refresh
      this._renderFiles();
    } catch (_e) { /* network error — silent */ }
  },

  _render() {
    const container = document.getElementById('view-files');
    container.innerHTML = `
      <div class="file-manager-toolbar">
        <div class="view-toggle">
          <button class="view-toggle-btn ${this._view === 'list' ? 'active' : ''}" data-v="list">≡ LIST</button>
          <button class="view-toggle-btn ${this._view === 'grid' ? 'active' : ''}" data-v="grid">⊞ GRID</button>
        </div>
        <select id="fm-sort" class="fm-select" aria-label="Sort files">
          ${[['date', 'SORT: DATE'], ['name', 'SORT: NAME'], ['size', 'SORT: SIZE']].map(([v, l]) => `<option value="${v}"${this._sort === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        <input id="fm-search" class="input fm-search" type="search" placeholder="SEARCH…" aria-label="Search files by name" />
        <select id="fm-perpage" class="fm-select" aria-label="Files per page">
          ${[25, 50, 100, 0].map(n => `<option value="${n}"${this._perPage === n ? ' selected' : ''}>SHOW: ${n === 0 ? 'ALL' : n}</option>`).join('')}
        </select>
        <button class="act-btn" id="btn-sync" title="Refresh files" aria-label="Refresh files">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"/><path d="M13.5 1.5v3h-3"/></svg>
        </button>
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

    const searchInput = container.querySelector('#fm-search');
    searchInput.addEventListener('input', Utils.debounce(() => {
      this._search = searchInput.value;
      this._page = 1;
      this._renderFiles();
    }, 200));

    const sortSelect = container.querySelector('#fm-sort');
    sortSelect.addEventListener('change', () => {
      this._sort = sortSelect.value;
      localStorage.setItem('fm-sort', this._sort);
      this.refresh();
    });

    const perPageSelect = container.querySelector('#fm-perpage');
    perPageSelect.addEventListener('change', () => {
      this._perPage = parseInt(perPageSelect.value, 10);
      localStorage.setItem('fm-perpage', this._perPage);
      this._page = 1;
      this._renderFiles();
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
   * Uses fetch + Blob + revokeObjectURL so it works on mobile browsers
   * that block programmatic anchor clicks for cross-origin/navigation URLs.
   */
  async _bulkDownload() {
    const ids = [...this._selected];
    if (ids.length === 0) return;

    Notifications.info(`DOWNLOADING ${ids.length} FILE${ids.length !== 1 ? 'S' : ''}`, 'Files will download one by one');

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const f = this._files.find((file) => file.id === id);
      const name = f ? f.name : id;

      try {
        // Fetch the file as a blob — works on mobile without popup-blocker issues
        const res = await fetch(`/api/files/${id}/download`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // Revoke after a short delay to let the browser start the download
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      } catch (err) {
        Notifications.error(`Failed to download ${name}`, err.message);
      }

      // Small gap between files to avoid overwhelming the browser
      if (i < ids.length - 1) {
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    Notifications.success('DOWNLOADS COMPLETE', `${ids.length} file${ids.length !== 1 ? 's' : ''} downloaded`);

    // Auto-deselect all files after download
    this._clearSelection();
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
      // Refresh bundles tab if it's currently visible
      if (typeof BundleLinksModule !== 'undefined') BundleLinksModule.refresh();
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

  /**
   * Set visibility (public/private) for all selected files.
   */
  async _bulkVisibility(isPublic) {
    const ids = [...this._selected];
    if (ids.length === 0) return;

    let ok = 0;
    let failed = 0;

    for (const id of ids) {
      const res = await Utils.apiFetch(`/api/files/${id}/visibility`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPublic }),
        credentials: 'same-origin',
      });
      if (res.ok) {
        ok++;
        const data = await res.json().catch(() => ({}));
        const f = this._files.find((file) => file.id === id);
        if (f) { f.is_public = isPublic; f.share_token = data.shareToken || null; }
      } else {
        failed++;
      }
    }

    this._renderFiles();
    if (ok > 0) Notifications.success(`${ok} file${ok !== 1 ? 's' : ''} made ${isPublic ? 'public' : 'private'}`);
    if (failed > 0) Notifications.error(`${failed} visibility change${failed !== 1 ? 's' : ''} failed`);
  },

  // ── Selection UI sync ──────────────────────────────────────────────────────

  /** Update every checkbox/row/card highlight from this._selected */
  _syncSelectionUI() {
    document.querySelectorAll('.fm-checkbox[data-id]').forEach((cb) => {
      const sel = this._selected.has(cb.dataset.id);
      cb.checked = sel;
      const row = cb.closest('tr');
      const card = cb.closest('.file-card');
      if (row) row.classList.toggle('file-row-selected', sel);
      if (card) card.classList.toggle('file-card-selected', sel);
    });
    this._updateBulkBar();
  },

  // ── Context menu (right-click on selected files) ───────────────────────────

  _hideContextMenu() {
    const menu = document.getElementById('fm-context-menu');
    if (menu) {
      if (menu._ac) menu._ac.abort();
      menu.remove();
    }
  },

  _showContextMenu(x, y) {
    this._hideContextMenu();
    const n = this._selected.size;
    if (n === 0) return;

    const ids = [...this._selected];
    const single = n === 1 ? this._files.find((f) => f.id === ids[0]) : null;
    const previewable = single && single.mime_type &&
      (single.mime_type.startsWith('image/') || single.mime_type === 'application/pdf');

    const icon = (paths) =>
      `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">${paths}</svg>`;

    const menu = document.createElement('div');
    menu.id = 'fm-context-menu';
    menu.className = 'fm-context-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <div class="fm-ctx-header">${n} file${n !== 1 ? 's' : ''} selected</div>
      <button class="fm-ctx-item" data-ctx="download" role="menuitem">
        ${icon('<path d="M8 2v8M5 7l3 3 3-3"/><path d="M2 13h12"/>')} DOWNLOAD
      </button>
      ${previewable ? `
      <button class="fm-ctx-item" data-ctx="preview" role="menuitem">
        ${icon('<path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/>')} PREVIEW
      </button>` : ''}
      <button class="fm-ctx-item" data-ctx="bundle" role="menuitem">
        ${icon('<circle cx="12" cy="4" r="2"/><circle cx="4" cy="8" r="2"/><circle cx="12" cy="12" r="2"/><path d="M6 7l4-2M6 9l4 2"/>')} CREATE BUNDLE LINK
      </button>
      <div class="fm-ctx-divider"></div>
      <button class="fm-ctx-item" data-ctx="public" role="menuitem">
        ${icon('<circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c-4 4.5-4 8.5 0 13M8 1.5c4 4.5 4 8.5 0 13"/>')} MAKE PUBLIC
      </button>
      <button class="fm-ctx-item" data-ctx="private" role="menuitem">
        ${icon('<rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>')} MAKE PRIVATE
      </button>
      <div class="fm-ctx-divider"></div>
      <button class="fm-ctx-item fm-ctx-danger" data-ctx="delete" role="menuitem">
        ${icon('<path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9h8l1-9"/>')} DELETE
      </button>
      <button class="fm-ctx-item" data-ctx="clear" role="menuitem">
        ${icon('<path d="M3 3l10 10M13 3L3 13"/>')} CLEAR SELECTION
      </button>
    `;
    document.body.appendChild(menu);

    // Clamp inside the viewport (flip away from edges)
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    menu.style.top  = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;

    menu.addEventListener('click', async (e) => {
      const item = e.target.closest('[data-ctx]');
      if (!item) return;
      const action = item.dataset.ctx;
      this._hideContextMenu();
      if (action === 'download')      await this._bulkDownload();
      else if (action === 'preview' && single) this._showPreview(single.id, single.mime_type, single.name);
      else if (action === 'bundle')   await this._bulkShare();
      else if (action === 'public')   await this._bulkVisibility(true);
      else if (action === 'private')  await this._bulkVisibility(false);
      else if (action === 'delete')   await this._bulkDelete();
      else if (action === 'clear')    this._clearSelection();
    });
    menu.addEventListener('contextmenu', (e) => e.preventDefault());

    // Dismiss on outside click, Escape, scroll, or resize
    const ac = new AbortController();
    menu._ac = ac;
    document.addEventListener('mousedown', (e) => {
      if (!menu.contains(e.target)) this._hideContextMenu();
    }, { signal: ac.signal, capture: true });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._hideContextMenu();
    }, { signal: ac.signal });
    document.addEventListener('scroll', () => this._hideContextMenu(),
      { signal: ac.signal, capture: true, passive: true });
    window.addEventListener('resize', () => this._hideContextMenu(),
      { signal: ac.signal });
  },

  // ── Rendering ──────────────────────────────────────────────────────────────

  _renderFiles() {
    const content = document.getElementById('files-content');
    if (!content) return;

    if (this._files.length === 0) {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⬡</div><div class="empty-state-text">NO FILES — DROP SOMETHING</div></div>`;
      return;
    }

    // Search filter (client-side, matches filename)
    const query = this._search.trim().toLowerCase();
    const files = query
      ? this._files.filter((f) => (f.name || '').toLowerCase().includes(query))
      : this._files;

    if (files.length === 0) {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⬡</div><div class="empty-state-text">NO MATCHES FOR “${Utils.escape(this._search.trim())}”</div></div>`;
      return;
    }

    // Pagination
    const total = files.length;
    const perPage = this._perPage === 0 ? total : this._perPage;
    const totalPages = Math.ceil(total / perPage);
    this._page = Math.min(this._page, totalPages);
    const start = (this._page - 1) * perPage;
    const end = Math.min(start + perPage, total);
    const pageFiles = files.slice(start, end);

    // Pagination info string e.g. "1–25 of 87"
    const rangeLabel = total > perPage
      ? `<span class="fm-range">${start + 1}–${end} of ${total}</span>`
      : `<span class="fm-range">${total} file${total !== 1 ? 's' : ''}</span>`;

    // Pagination controls
    const paginationHtml = totalPages > 1 ? `
      <div class="fm-pagination">
        <button class="fm-page-btn" data-pg="${this._page - 1}" ${this._page <= 1 ? 'disabled' : ''}>‹ PREV</button>
        ${Array.from({ length: totalPages }, (_, i) => i + 1).map(p => `
          <button class="fm-page-btn fm-page-num${p === this._page ? ' active' : ''}" data-pg="${p}">${p}</button>
        `).join('')}
        <button class="fm-page-btn" data-pg="${this._page + 1}" ${this._page >= totalPages ? 'disabled' : ''}>NEXT ›</button>
      </div>` : '';

    if (this._view === 'list') {
      content.innerHTML = `
        <div class="fm-table-header">${rangeLabel}</div>
        <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;width:100%;max-width:100%;">
        <table class="file-list">
          <thead>
            <tr>
              <th class="col-check">
                <label class="fm-check-label" title="Select all on this page">
                  <input type="checkbox" class="fm-checkbox fm-checkbox-all" aria-label="Select all files" />
                </label>
              </th>
              <th>NAME</th>
              <th>SIZE</th>
              <th>UPLOADED</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            ${pageFiles.map((f) => this._listRow(f)).join('')}
          </tbody>
        </table>
        </div>
        ${paginationHtml}
      `;

      // Select-all checkbox (scoped to current page)
      const allCb = content.querySelector('.fm-checkbox-all');
      const pageIds = pageFiles.map(f => f.id);
      const allPageSelected = pageIds.length > 0 && pageIds.every(id => this._selected.has(id));
      const somePageSelected = pageIds.some(id => this._selected.has(id));
      allCb.checked = allPageSelected;
      allCb.indeterminate = somePageSelected && !allPageSelected;
      allCb.addEventListener('change', () => {
        if (allCb.checked) {
          pageIds.forEach(id => this._selected.add(id));
        } else {
          pageIds.forEach(id => this._selected.delete(id));
        }
        this._renderFiles();
        this._updateBulkBar();
      });
    } else {
      content.innerHTML = `
        <div class="fm-table-header">${rangeLabel}</div>
        <div class="file-grid">${pageFiles.map((f) => this._gridCard(f)).join('')}</div>
        ${paginationHtml}
      `;
    }

    // Bind pagination button clicks
    content.querySelectorAll('.fm-page-btn[data-pg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pg = parseInt(btn.dataset.pg, 10);
        if (pg < 1 || pg > totalPages) return;
        this._page = pg;
        this._renderFiles();
        // Scroll file list into view
        document.getElementById('files-content')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    this._bindActions(content);
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
      <button class="act-btn act-btn--danger" data-action="delete" data-id="${f.id}" title="Delete">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9h8l1-9"/></svg>
      </button>
    `;
  },

  _listRow(f) {
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

    // ── Drag-to-select on the full view area (not just the table) ─────────
    const viewContainer = document.getElementById('view-files');
    if (viewContainer) this._bindDragSelect(viewContainer, sig);

    // ── Right-click context menu on rows/cards ─────────────────────────────
    // Right-clicking a selected file opens the menu for the whole selection.
    // Right-clicking an unselected file selects just that file first
    // (Google Drive behaviour). Empty space keeps the browser's own menu.
    root.addEventListener('contextmenu', (e) => {
      const el = e.target.closest('tbody tr, .file-card');
      if (!el) { this._hideContextMenu(); return; }
      const cb = el.querySelector('.fm-checkbox[data-id]');
      const id = cb ? cb.dataset.id : null;
      if (!id) return;
      e.preventDefault();
      if (!this._selected.has(id)) {
        this._selected.clear();
        this._selected.add(id);
        this._syncSelectionUI();
      }
      this._showContextMenu(e.clientX, e.clientY);
    }, sig);

    root.addEventListener('click', async (e) => {
      // ── Row/card click → toggle selection ─────────────────────────────
      // Clicking anywhere on a row or card (but NOT on an action button,
      // checkbox label, or interactive element) toggles that file's selection.
      if (!e.target.closest('[data-action], .fm-check-label, .fm-checkbox, button, a, input, select')) {
        const row  = e.target.closest('tbody tr');
        const card = e.target.closest('.file-card');
        const el   = row || card;
        if (el) {
          const cb = el.querySelector('.fm-checkbox[data-id]');
          if (cb) {
            const id = cb.dataset.id;
            this._toggleSelect(id);
            const selected = this._selected.has(id);
            cb.checked = selected;
            if (row)  row.classList.toggle('file-row-selected', selected);
            if (card) card.classList.toggle('file-card-selected', selected);
            // Update select-all checkbox state
            const allCb = root.querySelector('.fm-checkbox-all');
            if (allCb) {
              const pageIds = [...root.querySelectorAll('.fm-checkbox[data-id]')].map(c => c.dataset.id);
              allCb.checked = pageIds.length > 0 && pageIds.every(pid => this._selected.has(pid));
              allCb.indeterminate = pageIds.some(pid => this._selected.has(pid)) && !allCb.checked;
            }
          }
          return;
        }
      }

      // ── Action button clicks ───────────────────────────────────────────
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
      } else if (action === 'delete') {
        if (!await Utils.confirm('Delete this file?', 'Delete')) return;
        await this._deleteFile(id);
      }
    }, sig);
  },

  // ── Rubber-band drag-to-select (Google Drive style) ──────────────────────

  /**
   * Google Drive-style rubber-band selection:
   * - Click and drag on empty space → draws a translucent selection rectangle.
   * - Any file row/card whose bounding box intersects the rectangle gets selected.
   * - Holding Shift/Ctrl while dragging ADDS to the existing selection.
   * - Releasing the mouse finalises the selection.
   * - Touch: long-press (350ms) activates, then drag draws the lasso.
   */
  _bindDragSelect(root, sig) {
    const ds = this._dragSelect;
    ds.container = root;

    // ── Helpers ────────────────────────────────────────────────────────────

    /** Return the file-id for a selectable item element (tr or .file-card) */
    const getSelectableEl = (el) => {
      // List view — <tr> rows in tbody
      const row = el.closest('tbody tr');
      if (row) return row;
      // Grid view — .file-card
      const card = el.closest('.file-card');
      if (card) return card;
      return null;
    };

    const getIdFromEl = (el) => {
      const cb = el.querySelector('.fm-checkbox[data-id]');
      return cb ? cb.dataset.id : null;
    };

    /** Collect all selectable elements currently rendered */
    const getAllSelectables = () => [
      ...root.querySelectorAll('tbody tr, .file-card'),
    ];

    /** Given two viewport points, return a normalised DOMRect */
    const makeRect = (x1, y1, x2, y2) => ({
      left:   Math.min(x1, x2),
      top:    Math.min(y1, y2),
      right:  Math.max(x1, x2),
      bottom: Math.max(y1, y2),
      width:  Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    });

    /** Do two rects intersect? */
    const rectsIntersect = (a, b) =>
      a.left < b.right && a.right > b.left &&
      a.top  < b.bottom && a.bottom > b.top;

    // ── Scroll container ───────────────────────────────────────────────────
    // html and body both have overflow-x:hidden, which makes the BODY its own
    // scroll container — window.scrollY stays 0 and window.scrollBy() is a
    // no-op. Detect the element that actually scrolls the file list instead
    // of assuming the window does.

    const getScroller = () => {
      let el = root.parentElement;
      while (el) {
        const { overflowY } = getComputedStyle(el);
        const scrollable = overflowY === 'auto' || overflowY === 'scroll';
        if (scrollable && el.scrollHeight > el.clientHeight + 1) return el;
        el = el.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    };

    let _scroller = null;
    const scrollLeft = () => (_scroller ? _scroller.scrollLeft : 0);
    const scrollTop  = () => (_scroller ? _scroller.scrollTop  : 0);

    // ── Lasso rectangle element ────────────────────────────────────────────

    const ensureLasso = () => {
      if (ds.rect) return ds.rect;
      const el = document.createElement('div');
      el.className = 'drag-lasso';
      // Explicit inline reset so no inherited background can bleed through
      el.style.cssText = 'position:fixed;z-index:9998;pointer-events:none;margin:0;padding:0;';
      document.body.appendChild(el);
      ds.rect = el;
      return el;
    };

    const removeLasso = () => {
      if (ds.rect) { ds.rect.remove(); ds.rect = null; }
    };

    const updateLasso = (x1, y1, x2, y2) => {
      const lasso = ensureLasso();
      const r = makeRect(x1, y1, x2, y2);
      lasso.style.left   = `${r.left}px`;
      lasso.style.top    = `${r.top}px`;
      lasso.style.width  = `${r.width}px`;
      lasso.style.height = `${r.height}px`;
    };

    // ── Selection update during drag ───────────────────────────────────────

    const updateSelection = (x1, y1, x2, y2, additive) => {
      const lassoRect = makeRect(x1, y1, x2, y2);
      const base = additive ? new Set(ds.preSelected) : new Set();

      // Read all bounding rects in one pass (batch layout reads before writes)
      const selectables = getAllSelectables();
      const rects = selectables.map((el) => el.getBoundingClientRect());

      selectables.forEach((el, i) => {
        const id = getIdFromEl(el);
        if (!id) return;
        if (rectsIntersect(lassoRect, rects[i])) base.add(id);
      });

      this._selected = base;

      // Batch DOM writes after all reads
      selectables.forEach((el) => {
        const id = getIdFromEl(el);
        if (!id) return;
        const selected = this._selected.has(id);
        const cb = el.querySelector('.fm-checkbox[data-id]');
        if (cb) cb.checked = selected;
        if (el.tagName === 'TR') {
          el.classList.toggle('file-row-selected', selected);
        } else {
          el.classList.toggle('file-card-selected', selected);
        }
      });

      this._updateBulkBar();
    };

    // ── Start drag ─────────────────────────────────────────────────────────

    const startDrag = (clientX, clientY, additive) => {
      ds.active      = true;
      ds.startX      = clientX;
      ds.startY      = clientY;
      // Anchor in CONTENT coordinates of the real scroll container so the
      // lasso stays glued to the rows when the list scrolls mid-drag
      // (auto-scroll or mouse wheel).
      _scroller      = getScroller();
      ds.startDocX   = clientX + scrollLeft();
      ds.startDocY   = clientY + scrollTop();
      ds.preSelected = new Set(this._selected);
      ds._dragging   = false; // real drag hasn't started yet — waiting for threshold
      ds._additive   = additive;
      document.body.style.userSelect       = 'none';
      document.body.style.webkitUserSelect = 'none';
    };

    // Anchor converted back to current viewport coordinates — shifts as the
    // list scrolls so element getBoundingClientRect() comparisons stay valid
    const anchorX = () => ds.startDocX - scrollLeft();
    const anchorY = () => ds.startDocY - scrollTop();

    // Called once the mouse moves beyond DRAG_THRESHOLD — commits the drag
    const DRAG_THRESHOLD = 5; // px
    const commitDrag = (additive) => {
      if (ds._dragging) return;
      ds._dragging = true;
      // Don't clear selection here — updateSelection() already starts from an
      // empty base when non-additive, so the lasso result replaces the old
      // selection naturally as it grows. Clearing eagerly here caused plain
      // clicks on empty space (with tiny mouse movement) to wipe the selection.
      updateLasso(anchorX(), anchorY(), _curX, _curY);
    };

    // ── End drag ───────────────────────────────────────────────────────────

    const endDrag = () => {
      if (!ds.active) return;
      const wasDragging = ds._dragging;
      ds.active    = false;
      ds._dragging = false;
      removeLasso();
      stopAutoScroll();
      document.body.style.userSelect       = '';
      document.body.style.webkitUserSelect = '';
      // Plain click on empty space (no real drag) → clear selection.
      // A real drag replaces selection via updateSelection() during the drag.
      if (!wasDragging && !ds._additive) {
        this._clearSelection();
      }
    };

    // ── Auto-scroll when cursor is near viewport edges ─────────────────────
    // Mirrors Google Drive behaviour: drag to bottom/top edge scrolls the page.

    let _scrollRaf = null;
    let _curX = 0;
    let _curY = 0;
    const SCROLL_ZONE  = 80;  // px from edge that triggers scroll
    const SCROLL_SPEED = 12;  // max px per frame

    const autoScrollTick = () => {
      if (!ds.active) return;
      if (!_scroller) _scroller = getScroller();

      const vh = window.innerHeight;
      // Scroll zones relative to the scroller's visible area (clamped to the
      // viewport in case the scroller is taller than the screen).
      const isDocScroller = _scroller === document.body ||
        _scroller === document.documentElement;
      const sRect = isDocScroller
        ? { top: 0, bottom: vh }
        : _scroller.getBoundingClientRect();
      const topEdge = Math.max(sRect.top, 0);
      // Account for the bulk-action bar (fixed at bottom) so the scroll zone
      // starts above it, not behind it.
      const bulkBar = document.getElementById('bulk-action-bar');
      const bulkBarH = (bulkBar && !bulkBar.classList.contains('hidden'))
        ? bulkBar.offsetHeight : 0;
      const bottomEdge = Math.min(sRect.bottom, vh) - bulkBarH;
      let delta = 0;

      if (_curY < topEdge + SCROLL_ZONE) {
        // Near top — scroll up, faster the closer to the edge
        delta = -SCROLL_SPEED * (1 - (_curY - topEdge) / SCROLL_ZONE);
      } else if (_curY > bottomEdge - SCROLL_ZONE) {
        // Near bottom — scroll down (above the bulk bar)
        delta = SCROLL_SPEED * (1 - (bottomEdge - _curY) / SCROLL_ZONE);
      }

      if (delta !== 0) {
        // At least 1px per frame so movement starts right at the zone edge
        delta = delta > 0 ? Math.max(1, delta) : Math.min(-1, delta);
        _scroller.scrollTop += delta;
        // After scrolling, re-evaluate with the anchor mapped to the new
        // viewport position so the lasso keeps growing past one screenful
        updateSelection(anchorX(), anchorY(), _curX, _curY,
          ds._lastAdditive || false);
        updateLasso(anchorX(), anchorY(), _curX, _curY);
      }

      _scrollRaf = requestAnimationFrame(autoScrollTick);
    };

    const startAutoScroll = () => {
      if (_scrollRaf) return;
      _scrollRaf = requestAnimationFrame(autoScrollTick);
    };

    const stopAutoScroll = () => {
      if (_scrollRaf) { cancelAnimationFrame(_scrollRaf); _scrollRaf = null; }
    };

    // ── Mouse events ───────────────────────────────────────────────────────

    // mousedown on the container background (not on interactive elements)
    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // Don't start lasso if clicking on an interactive element
      if (e.target.closest('[data-action], .fm-checkbox, .fm-check-label, button, a, input, select')) return;
      // Don't start lasso on a row/card — those are handled by the click handler.
      // Only start lasso on the container background (empty space).
      if (getSelectableEl(e.target)) return;
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      startDrag(e.clientX, e.clientY, additive);
      e.preventDefault(); // prevent text selection during lasso
    }, sig);

    // mousemove on document so lasso works even if cursor leaves the container
    let _rafPending = false;
    const onMouseMove = (e) => {
      if (!ds.active) return;
      _curX = e.clientX;
      _curY = e.clientY;
      ds._lastAdditive = e.shiftKey || e.ctrlKey || e.metaKey;

      // Only commit to a drag once the mouse moves beyond the threshold
      if (!ds._dragging) {
        const dx = _curX - ds.startX;
        const dy = _curY - ds.startY;
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
        commitDrag(ds._additive);
      }

      // Update lasso visually on every event (cheap — just CSS)
      updateLasso(anchorX(), anchorY(), _curX, _curY);

      // Throttle the expensive selection recalc to once per animation frame
      if (!_rafPending) {
        _rafPending = true;
        requestAnimationFrame(() => {
          _rafPending = false;
          if (!ds.active) return;
          updateSelection(anchorX(), anchorY(), _curX, _curY, ds._lastAdditive);
        });
      }

      startAutoScroll();
    };

    const onMouseUp = () => { endDrag(); };

    // Wheel/trackpad scrolling mid-drag moves the content under a stationary
    // cursor — mousemove won't fire, so recompute on scroll as well
    const onScroll = () => {
      if (!ds.active || !ds._dragging) return;
      updateLasso(anchorX(), anchorY(), _curX, _curY);
      updateSelection(anchorX(), anchorY(), _curX, _curY,
        ds._lastAdditive || ds._additive);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    // Capture phase so we hear scrolls from ANY scroll container (element
    // scroll events don't bubble, and the list scrolls inside <body>)
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });

    // Clean up document-level listeners when the AbortController fires
    sig.signal.addEventListener('abort', () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('scroll', onScroll, { capture: true });
      stopAutoScroll();
      endDrag();
    });

    // ── Touch events (long-press 350ms → lasso) ────────────────────────────

    let touchTimer = null;
    let touchActive = false;
    let touchStartX = 0;
    let touchStartY = 0;

    root.addEventListener('touchstart', (e) => {
      if (e.target.closest('[data-action], .fm-checkbox, .fm-check-label, button, a, input')) return;
      const t = e.touches[0];
      touchStartX = t.clientX;
      touchStartY = t.clientY;

      touchTimer = setTimeout(() => {
        touchActive = true;
        if (navigator.vibrate) navigator.vibrate(30);
        startDrag(touchStartX, touchStartY, false);
      }, 350);
    }, sig);

    root.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      // Cancel long-press if finger moved significantly before timer fires
      if (!touchActive) {
        const dx = t.clientX - touchStartX;
        const dy = t.clientY - touchStartY;
        if (Math.sqrt(dx * dx + dy * dy) > 8) clearTimeout(touchTimer);
        return;
      }
      e.preventDefault();
      _curX = t.clientX;
      _curY = t.clientY;
      updateLasso(anchorX(), anchorY(), _curX, _curY);
      updateSelection(anchorX(), anchorY(), _curX, _curY, false);
      // Dragging the finger to the screen edge auto-scrolls, same as mouse
      startAutoScroll();
    }, { signal: sig.signal, passive: false });

    root.addEventListener('touchend', () => {
      clearTimeout(touchTimer);
      if (touchActive) { touchActive = false; endDrag(); }
    }, sig);

    root.addEventListener('touchcancel', () => {
      clearTimeout(touchTimer);
      touchActive = false;
      endDrag();
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

  async _deleteFile(id) {
    const res = await Utils.apiFetch(`/api/files/${id}`, { method: 'DELETE', credentials: 'same-origin' });
    if (res.ok) {
      this._files = this._files.filter((f) => f.id !== id);
      this._selected.delete(id);
      // If current page is now empty, go back one page
      const perPage = this._perPage === 0 ? this._files.length || 1 : this._perPage;
      const totalPages = Math.max(1, Math.ceil(this._files.length / perPage));
      if (this._page > totalPages) this._page = totalPages;
      this._renderFiles();
      this._updateBulkBar();
      Notifications.success('File deleted');
    } else {
      Notifications.error('Delete failed');
    }
  },

};
