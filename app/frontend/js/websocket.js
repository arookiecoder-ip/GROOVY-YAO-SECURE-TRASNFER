const WSClient = {
  _ws: null,
  _handlers: {},
  _reconnectDelay: 1000,
  _maxDelay: 30000,
  _dot: null,

  init() {
    this._dot = document.getElementById('ws-status');
    this._connect();
  },

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this._ws = new WebSocket(`${proto}//${location.host}/ws`);
    this._setStatus('connecting');

    this._ws.onopen = () => {
      this._setStatus('connected');
      this._reconnectDelay = 1000;
      this._emit('open');
    };

    this._ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this._emit(msg.type, msg);
      } catch { /* ignore malformed */ }
    };

    this._ws.onclose = () => {
      this._setStatus('disconnected');
      this._scheduleReconnect();
    };

    this._ws.onerror = () => {
      this._ws.close();
    };
  },

  _scheduleReconnect() {
    setTimeout(() => this._connect(), this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
  },

  _setStatus(state) {
    if (!this._dot) return;
    this._dot.className = `ws-dot ws-${state}`;
  },

  on(type, handler) {
    if (!this._handlers[type]) this._handlers[type] = [];
    this._handlers[type].push(handler);
  },

  off(type, handler) {
    if (!this._handlers[type]) return;
    this._handlers[type] = this._handlers[type].filter((h) => h !== handler);
  },

  send(type, data = {}) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type, ...data }));
    }
  },

  _emit(type, data) {
    (this._handlers[type] || []).forEach((h) => h(data));
  },
};
