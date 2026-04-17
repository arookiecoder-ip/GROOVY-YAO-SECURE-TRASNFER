const SetupModule = {
  _passkeyDone: false,

  init() {
    document.getElementById('btn-setup-passkey').addEventListener('click', () => this._registerPasskey());
    document.getElementById('btn-setup-skip-passkey').addEventListener('click', () => this._showTotpStep());
    document.getElementById('btn-setup-totp-confirm').addEventListener('click', () => this._confirmTotp());
    document.getElementById('setup-totp-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._confirmTotp();
    });
  },

  async _registerPasskey() {
    this._clearError();
    const btn = document.getElementById('btn-setup-passkey');
    btn.disabled = true;
    try {
      const beginRes = await fetch('/api/auth/webauthn/register/begin', { method: 'POST', credentials: 'same-origin' });
      if (!beginRes.ok) throw new Error(await beginRes.text());
      const options = await beginRes.json();

      const credential = await navigator.credentials.create({ publicKey: this._decodeRegOptions(options) });

      const completeRes = await fetch('/api/auth/webauthn/register/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._encodeCredential(credential)),
        credentials: 'same-origin',
      });
      if (!completeRes.ok) {
        const err = await completeRes.json().catch(() => ({}));
        throw new Error(err.error || 'Registration failed');
      }

      this._passkeyDone = true;
      document.getElementById('setup-passkey-status').textContent = '✓ PASSKEY REGISTERED';
      document.getElementById('setup-passkey-status').style.color = 'var(--color-green)';
      await this._showTotpStep();
    } catch (err) {
      btn.disabled = false;
      this._showError(err.message);
    }
  },

  async _showTotpStep() {
    document.getElementById('setup-step-passkey').classList.add('hidden');
    document.getElementById('setup-step-totp').classList.remove('hidden');

    // Fetch QR from server
    const res = await fetch('/api/auth/totp/setup', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // If already configured (409), skip TOTP step — passkey was registered, go straight to app
      if (res.status === 409 && this._passkeyDone) {
        this._done();
        return;
      }
      this._showError(err.error || 'TOTP setup failed');
      return;
    }
    const { qrDataUrl } = await res.json();
    document.getElementById('setup-qr').innerHTML = `<img src="${qrDataUrl}" alt="TOTP QR Code" style="max-width:200px" />`;
    document.getElementById('setup-totp-input').focus();
  },

  async _confirmTotp() {
    this._clearError();
    const input = document.getElementById('setup-totp-input');
    const token = input.value.trim();
    if (!/^\d{6}$/.test(token)) { this._showError('Enter 6-digit code'); return; }

    const btn = document.getElementById('btn-setup-totp-confirm');
    btn.disabled = true;
    try {
      const res = await fetch('/api/auth/totp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Invalid code');
      }
      this._done();
    } catch (err) {
      btn.disabled = false;
      input.value = '';
      input.focus();
      this._showError(err.message);
    }
  },

  _done() {
    document.getElementById('setup-step-totp').classList.add('hidden');
    document.getElementById('setup-step-done').classList.remove('hidden');
    setTimeout(() => {
      document.getElementById('setup-screen').classList.add('hidden');
      window.GroovyYAO.showApp();
    }, 1200);
  },

  _showError(msg) {
    const el = document.getElementById('setup-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  },

  _clearError() {
    document.getElementById('setup-error').classList.add('hidden');
  },

  _decodeRegOptions(options) {
    const decode = (b64url) => {
      const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    };
    options.challenge = decode(options.challenge);
    options.user.id = decode(options.user.id);
    if (options.excludeCredentials) {
      options.excludeCredentials = options.excludeCredentials.map((c) => ({ ...c, id: decode(c.id) }));
    }
    return options;
  },

  _encodeCredential(cred) {
    const encode = (buf) =>
      btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return {
      id: cred.id,
      rawId: encode(cred.rawId),
      response: {
        attestationObject: encode(cred.response.attestationObject),
        clientDataJSON: encode(cred.response.clientDataJSON),
        transports: cred.response.getTransports ? cred.response.getTransports() : [],
      },
      type: cred.type,
    };
  },
};
