const Utils = {
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  },

  formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem}s`;
  },

  formatEta(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '--';
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.ceil(seconds % 60);
    return `${m}m ${s}s`;
  },

  formatRelativeTime(ts) {
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return new Date(ts).toLocaleDateString();
  },

  formatExpiry(expiresAt) {
    if (!expiresAt) return '∞';
    const diff = expiresAt - Date.now();
    if (diff <= 0) return 'expired';
    const s = Math.floor(diff / 1000);
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  },

  expiryClass(expiresAt) {
    if (!expiresAt) return '';
    const diff = expiresAt - Date.now();
    if (diff <= 0) return 'expiry-critical';
    if (diff < 10 * 60 * 1000) return 'expiry-critical';
    if (diff < 60 * 60 * 1000) return 'expiry-warning';
    return '';
  },

  debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  },

  escape(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  confirm(message, okLabel = 'Confirm') {
    return new Promise((resolve) => {
      const modal = document.getElementById('confirm-modal');
      const msg = document.getElementById('confirm-message');
      const ok = document.getElementById('confirm-ok');
      const cancel = document.getElementById('confirm-cancel');
      msg.textContent = message;
      ok.textContent = okLabel;
      modal.classList.remove('hidden');
      const cleanup = (result) => {
        modal.classList.add('hidden');
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        resolve(result);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
    });
  },

  /**
   * Read the CSRF token from the csrf_token cookie.
   * The cookie value is "token.signature" — we only need the token part.
   */
  getCsrfToken() {
    const match = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('csrf_token='));
    if (!match) return '';
    const val = match.slice('csrf_token='.length);
    return val.split('.')[0]; // token is before the dot
  },

  /**
   * Drop-in replacement for fetch() that automatically injects the
   * X-CSRF-Token header on state-mutating requests.
   * Usage: Utils.apiFetch('/api/files/123', { method: 'DELETE', credentials: 'same-origin' })
   */
  apiFetch(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    if (mutating) {
      opts.headers = opts.headers || {};
      opts.headers['x-csrf-token'] = this.getCsrfToken();
    }
    opts.credentials = opts.credentials || 'same-origin';
    return fetch(url, opts);
  },

  async copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* fall through */ }
    }
    // Fallback for HTTP / non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  },
};
