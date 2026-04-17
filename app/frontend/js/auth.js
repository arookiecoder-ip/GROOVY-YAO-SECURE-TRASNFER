const AuthModule = {
  init() {
    document.getElementById('btn-passkey').addEventListener('click', () => this.passkeyAuth());
    document.getElementById('btn-combo').addEventListener('click', () => this.comboAuth());
    document.getElementById('password-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.comboAuth();
    });
    const totpInput = document.getElementById('totp-input');
    totpInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { this.comboAuth(); return; }
      if (e.metaKey || e.ctrlKey || ['Backspace','Delete','Tab','ArrowLeft','ArrowRight'].includes(e.key)) return;
      if (!/^\d$/.test(e.key)) e.preventDefault();
    });
    totpInput.addEventListener('input', () => {
      totpInput.value = totpInput.value.replace(/\D/g, '').slice(0, 6);
    });
  },

  async passkeyAuth() {
    this._clearError();
    const btn = document.getElementById('btn-passkey');
    btn.disabled = true;
    try {
      const beginRes = await fetch('/api/auth/webauthn/authenticate/begin', { method: 'POST', credentials: 'same-origin' });
      if (!beginRes.ok) throw new Error('Server error — try again');
      const options = await beginRes.json();

      const credential = await navigator.credentials.get({ publicKey: this._decodeAuthOptions(options) });
      const remember = document.getElementById('remember-device')?.checked || false;
      const completeRes = await fetch('/api/auth/webauthn/authenticate/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...this._encodeCredential(credential), rememberDevice: remember }),
        credentials: 'same-origin',
      });
      if (!completeRes.ok) {
        const err = await completeRes.json().catch(() => ({}));
        throw new Error(err.message || 'Authentication failed');
      }
      window.GroovyYAO.showApp();
    } catch (err) {
      this._showError(err.message || 'Authentication failed');
    } finally {
      btn.disabled = false;
    }
  },

  async comboAuth() {
    this._clearError();
    const totpInput = document.getElementById('totp-input');
    const pwInput = document.getElementById('password-input');
    const totpToken = totpInput.value.trim();
    const password = pwInput.value;
    if (!/^\d{6}$/.test(totpToken)) { this._showError('Enter 6-digit TOTP code'); totpInput.focus(); return; }
    if (!password) { this._showError('Enter your password'); pwInput.focus(); return; }
    const btn = document.getElementById('btn-combo');
    btn.disabled = true;
    try {
      const res = await fetch('/api/auth/combo/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totpToken, password, rememberDevice: document.getElementById('remember-device')?.checked || false }),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Invalid credentials');
      }
      window.GroovyYAO.showApp();
    } catch (err) {
      this._showError(err.message);
      totpInput.value = '';
      pwInput.value = '';
      totpInput.focus();
    } finally {
      btn.disabled = false;
    }
  },

  _showError(msg) {
    const el = document.getElementById('auth-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  },

  _clearError() {
    document.getElementById('auth-error').classList.add('hidden');
  },

  _decodeAuthOptions(options) {
    // Convert base64url to ArrayBuffer where needed
    const decode = (b64url) => {
      const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64);
      return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
    };
    options.challenge = decode(options.challenge);
    if (options.allowCredentials) {
      options.allowCredentials = options.allowCredentials.map((c) => ({ ...c, id: decode(c.id) }));
    }
    return options;
  },

  _encodeCredential(cred) {
    const encode = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return {
      id: cred.id,
      rawId: encode(cred.rawId),
      response: {
        authenticatorData: encode(cred.response.authenticatorData),
        clientDataJSON: encode(cred.response.clientDataJSON),
        signature: encode(cred.response.signature),
        userHandle: cred.response.userHandle ? encode(cred.response.userHandle) : null,
      },
      type: cred.type,
    };
  },
};
