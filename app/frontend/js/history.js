const HistoryModule = {
  async init() {
    const container = document.getElementById('view-history');
    container.innerHTML = '<div style="color:var(--color-text-dim);padding:24px">LOADING...</div>';
    try {
      const res = await fetch('/api/history', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load history');
      const events = await res.json();
      this._render(container, events);
    } catch (err) {
      container.innerHTML = `<div style="color:var(--color-red);padding:24px">${Utils.escape(err.message)}</div>`;
    }
  },

  _render(container, events) {
    if (events.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⬡</div><div class="empty-state-text">NO HISTORY YET</div></div>';
      return;
    }
    container.innerHTML = `
      <table class="history-table">
        <thead><tr><th>EVENT</th><th>FILE</th><th>SIZE</th><th>TIME</th></tr></thead>
        <tbody>
          ${events.map((e) => `
            <tr>
              <td class="event-${e.event_type}">${e.event_type.toUpperCase()}</td>
              <td>${e.file_id ? Utils.escape(e.file_id.slice(0, 8) + '…') : '—'}</td>
              <td>${e.size_bytes ? Utils.formatBytes(e.size_bytes) : '—'}</td>
              <td>${Utils.formatRelativeTime(e.timestamp)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  },
};
