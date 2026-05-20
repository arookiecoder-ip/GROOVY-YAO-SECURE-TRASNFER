// BundleLinksModule — manage created bundle links
const BundleLinksModule = {
  _bundles: [],

  init() {
    this.refresh();
  },

  async refresh() {
    const el = document.getElementById('view-bundles');
    if (!el) return;
    try {
      const res = await fetch('/api/bundles', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load');
      const { bundles } = await res.json();
      this._bundles = bundles || [];
      this._render(el);
    } catch {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-text">Failed to load bundle links.</div></div>';
    }
  },

  _status(b) {
    if (b.revoked)  return { label: 'REVOKED',  cls: 'ul-status-dead' };
    if (b.expired)  return { label: 'EXPIRED',  cls: 'ul-status-dead' };
    return { label: 'ACTIVE', cls: 'ul-status-active' };
  },

  _fmt(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  },

  _render(el) {
    const toolbar = `
      <div class="ul-toolbar">
        <div class="ul-title">// BUNDLE LINKS</div>
        <div class="ul-actions">
          <button class="btn btn-ghost btn-sm" id="bl-btn-refresh">⟳ REFRESH</button>
        </div>
      </div>`;

    if (this._bundles.length === 0) {
      el.innerHTML = toolbar + `
        <div class="empty-state">
          <div class="empty-state-icon">⬡</div>
          <div class="empty-state-text">NO BUNDLE LINKS YET</div>
          <div class="empty-state-text" style="font-size:.75rem;margin-top:8px;color:var(--color-text-dim)">
            Select files in the FILES tab and click CREATE BUNDLE
          </div>
        </div>`;
      this._bindToolbar(el);
      return;
    }

    const rows = this._bundles.map((b) => {
      const s = this._status(b);
      const canRevoke = !b.revoked && !b.expired;
      const url = b.url;
      return `
        <tr class="ul-row" data-id="${b.id}">
          <td class="ul-cell-url">
            <span class="ul-url" title="${Utils.escape(url)}">${Utils.escape(url)}</span>
          </td>
          <td>
            <span class="bl-file-count">${b.fileCount} file${b.fileCount !== 1 ? 's' : ''}</span>
          </td>
          <td><span class="ul-status ${s.cls}">${s.label}</span></td>
          <td class="ul-cell-date">${this._fmt(b.created_at)}</td>
          <td class="ul-cell-date">${b.download_count}</td>
          <td>
            <div class="ul-row-actions">
              ${canRevoke ? `<button class="btn btn-ghost btn-sm bl-btn-copy" data-url="${Utils.escape(url)}" title="Copy link">COPY</button>` : ''}
              ${canRevoke ? `<button class="btn btn-ghost btn-sm bl-btn-open" data-url="${Utils.escape(url)}" title="Open bundle page">OPEN</button>` : ''}
              ${canRevoke ? `<button class="btn btn-danger btn-sm bl-btn-revoke" data-id="${b.id}" title="Revoke bundle">REVOKE</button>` : ''}
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
              <th>BUNDLE LINK</th>
              <th>FILES</th>
              <th>STATUS</th>
              <th>CREATED</th>
              <th>OPENS</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    this._bindToolbar(el);

    el.querySelectorAll('.bl-btn-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        Utils.copyToClipboard(btn.dataset.url);
        Notifications.success('BUNDLE LINK COPIED', btn.dataset.url);
      });
    });

    el.querySelectorAll('.bl-btn-open').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.open(btn.dataset.url, '_blank', 'noopener');
      });
    });

    el.querySelectorAll('.bl-btn-revoke').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!await Utils.confirm('Revoke this bundle? Anyone with the link will lose access.', 'Revoke')) return;
        btn.disabled = true;
        btn.textContent = '...';
        try {
          const res = await Utils.apiFetch(`/api/bundles/${btn.dataset.id}`, {
            method: 'DELETE', credentials: 'same-origin',
          });
          if (!res.ok) throw new Error('Failed');
          Notifications.success('BUNDLE REVOKED', '');
          this.refresh();
        } catch {
          Notifications.error('Failed', 'Could not revoke bundle');
          btn.disabled = false;
          btn.textContent = 'REVOKE';
        }
      });
    });
  },

  _bindToolbar(el) {
    el.querySelector('#bl-btn-refresh')?.addEventListener('click', () => this.refresh());
  },
};
