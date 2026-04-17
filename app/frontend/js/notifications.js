const Notifications = {
  _container: null,

  init() {
    this._container = document.getElementById('toast-container');
  },

  show(title, body = '', type = 'info', duration = 4000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type} toast-enter`;
    toast.innerHTML = `
      <div class="toast-title">${Utils.escape(title)}</div>
      ${body ? `<div class="toast-body">${Utils.escape(body)}</div>` : ''}
    `;
    this._container.appendChild(toast);

    if (duration > 0) {
      setTimeout(() => this._dismiss(toast), duration);
    }
    return toast;
  },

  success(title, body, duration) { return this.show(title, body, 'success', duration); },
  error(title, body, duration)   { return this.show(title, body, 'error', duration); },
  warn(title, body, duration)    { return this.show(title, body, 'warn', duration); },
  info(title, body, duration)    { return this.show(title, body, 'info', duration); },

  _dismiss(toast) {
    toast.classList.remove('toast-enter');
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  },
};
