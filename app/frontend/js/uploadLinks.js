const UploadLinksModule = {
  init() {
    this.refresh();
  },

  async refresh() {
    const el = document.getElementById('view-upload-links');
    if (!el) return;
    try {
      const res = await fetch('/api/upload-requests', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load');
      const { requests } = await res.json();
      this._render(el, requests);
    } catch {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-text">Failed to load upload links.</div></div>';
    }
  },

  _status(r) {
    if (r.used && r.file_id) return { label: 'USED', cls: 'ul-status-used' };
    if (r.used)              return { label: 'DEACTIVATED', cls: 'ul-status-dead' };
    if (r.expired)           return { label: 'EXPIRED', cls: 'ul-status-dead' };
    return { label: 'ACTIVE', cls: 'ul-status-active' };
  },

  _fmt(ts) {
    return new Date(ts).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  },

  _render(el, requests) {
    const toolbar = `
      <div class="ul-toolbar">
        <div class="ul-title">// UPLOAD LINKS</div>
        <div class="ul-actions">
          <button class="btn btn-ghost btn-sm" id="ul-btn-new">⬆ NEW LINK</button>
          <button class="btn btn-ghost btn-sm" id="ul-btn-refresh">⟳ REFRESH</button>
        </div>
      </div>`;

    if (requests.length === 0) {
      el.innerHTML = toolbar + '<div class="empty-state"><div class="empty-state-icon">⬡</div><div class="empty-state-text">NO UPLOAD LINKS YET</div></div>';
      this._bindToolbar(el);
      return;
    }

    const rows = requests.map((r) => {
      const s = this._status(r);
      const canDeactivate = !r.used && !r.expired;
      return `
        <tr class="ul-row" data-id="${r.id}">
          <td class="ul-cell-url">
            <span class="ul-url" title="${r.url}">${r.url}</span>
          </td>
          <td><span class="ul-status ${s.cls}">${s.label}</span></td>
          <td class="ul-cell-date">${this._fmt(r.created_at)}</td>
          <td class="ul-cell-date">${this._fmt(r.expires_at)}</td>
          <td>
            <div class="ul-row-actions">
              ${canDeactivate ? `<button class="btn btn-ghost btn-sm ul-btn-copy" data-url="${r.url}" title="Copy link">COPY</button>` : ''}
              ${canDeactivate ? `<button class="btn btn-danger btn-sm ul-btn-deactivate" data-id="${r.id}" title="Deactivate link">DEACTIVATE</button>` : ''}
            </div>
          </td>
        </tr>`;
    }).join('');

    el.innerHTML = `
      ${toolbar}
      <div class="ul-table-wrap">
        <table class="ul-table">
          <thead>
            <tr>
              <th>LINK</th>
              <th>STATUS</th>
              <th>CREATED</th>
              <th>EXPIRES</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    this._bindToolbar(el);

    el.querySelectorAll('.ul-btn-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        Utils.copyToClipboard(btn.dataset.url);
        Notifications.success('LINK COPIED', btn.dataset.url);
      });
    });

    el.querySelectorAll('.ul-btn-deactivate').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '...';
        try {
          const res = await fetch(`/api/upload-requests/${btn.dataset.id}`, {
            method: 'DELETE', credentials: 'same-origin',
          });
          if (!res.ok) throw new Error('Failed');
          Notifications.success('LINK DEACTIVATED', '');
          this.refresh();
        } catch {
          Notifications.error('Failed', 'Could not deactivate link');
          btn.disabled = false;
          btn.textContent = 'DEACTIVATE';
        }
      });
    });
  },

  _bindToolbar(el) {
    el.querySelector('#ul-btn-new')?.addEventListener('click', () => {
      if (typeof AppMain !== 'undefined') AppMain.openUlDialog();
    });
    el.querySelector('#ul-btn-refresh')?.addEventListener('click', () => this.refresh());
  },
};
