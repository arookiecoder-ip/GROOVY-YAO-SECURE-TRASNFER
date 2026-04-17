// Entry point — boot sequence then route to auth or main app

(function () {
  'use strict';

  const BOOT_DURATION = 2400;
  const MATRIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*<>[]{}';

  function randomChar() {
    return MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
  }

  function createMatrixRain(container) {
    const cols = Math.ceil(window.innerWidth / 14);
    const colEls = [];

    for (let i = 0; i < cols; i++) {
      const col = document.createElement('div');
      col.style.cssText = `
        position: absolute;
        top: 0;
        left: ${i * 14}px;
        width: 14px;
        font-size: 11px;
        color: rgba(0, 245, 255, 0.25);
        font-family: var(--font-mono, monospace);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        height: 100%;
      `;
      container.appendChild(col);
      colEls.push(col);
    }

    const rows = Math.ceil(window.innerHeight / 16);
    colEls.forEach((col) => {
      for (let r = 0; r < rows; r++) {
        const span = document.createElement('span');
        span.style.lineHeight = '16px';
        span.textContent = randomChar();
        col.appendChild(span);
      }
    });

    let frame = 0;
    function tick() {
      frame++;
      colEls.forEach((col) => {
        const spans = col.querySelectorAll('span');
        spans.forEach((s) => {
          if (Math.random() < 0.06) s.textContent = randomChar();
        });
      });
      return requestAnimationFrame(tick);
    }
    const rafId = tick();
    return rafId;
  }

  async function checkSession() {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function checkFirstRun() {
    try {
      const res = await fetch('/api/auth/first-run', { credentials: 'same-origin' });
      const data = await res.json();
      return data.firstRun === true;
    } catch {
      return false;
    }
  }

  async function boot() {
    const bootScreen = document.getElementById('boot-screen');
    const bootMatrix = document.getElementById('boot-matrix');
    const bootLogo = document.getElementById('boot-logo');

    const rafId = createMatrixRain(bootMatrix);

    await delay(800);
    bootLogo.classList.add('boot-logo-visible');

    const [sessionValid, isFirstRun] = await Promise.all([
      checkSession(),
      checkFirstRun(),
      delay(BOOT_DURATION - 800),
    ]);

    cancelAnimationFrame(rafId);

    bootScreen.style.transition = 'opacity 0.4s ease';
    bootScreen.style.opacity = '0';
    await delay(400);
    bootScreen.style.display = 'none';
    document.body.classList.remove('boot-phase');

    if (sessionValid) {
      showApp();
    } else if (isFirstRun) {
      showSetupWizard();
    } else {
      showAuth();
    }
  }

  function showAuth() {
    document.getElementById('auth-screen').classList.remove('hidden');
    if (typeof AuthModule !== 'undefined') AuthModule.init();
  }

  function showSetupWizard() {
    document.getElementById('setup-screen').classList.remove('hidden');
    if (typeof SetupModule !== 'undefined') SetupModule.init();
  }

  function showApp() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    if (typeof AppMain !== 'undefined') AppMain.init();
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Expose for auth module to call after login
  window.GroovyYAO = { showApp, showAuth };

  // Main app controller
  window.AppMain = {
    init() {
      Notifications.init();
      WSClient.init();
      UploadManager.init();
      FileManagerModule.init();

      // Nav switching
      document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          const view = btn.dataset.view;
          document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
          const el = document.getElementById(`view-${view}`);
          if (el) el.classList.add('active');
          if (view === 'history') HistoryModule.init();
          if (view === 'stats') StatsModule.init();
        });
      });

      // Theme toggle
      const themeBtn = document.getElementById('btn-theme');
      const applyTheme = (dark) => {
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        themeBtn.textContent = dark ? '☀' : '☾';
        localStorage.setItem('theme', dark ? 'dark' : 'light');
      };
      const savedTheme = localStorage.getItem('theme');
      applyTheme(savedTheme !== 'light');
      themeBtn.addEventListener('click', () => {
        applyTheme(document.documentElement.getAttribute('data-theme') === 'light');
      });

      // Logout
      document.getElementById('btn-logout').addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        location.reload();
      });

      // WS events
      WSClient.on('FILE_EXPIRED', (msg) => {
        Notifications.warn('File expired', msg.fileId);
        FileManagerModule.refresh();
      });
      WSClient.on('UPLOAD_PROGRESS', (msg) => {
        Progress.update(msg.uploadId, msg.percent, msg.bytesLoaded || 0, msg.speedBps || 0);
      });
      WSClient.on('UPLOAD_COMPLETE', (msg) => {
        Progress.complete(msg.uploadId);
        FileManagerModule.refresh();
      });
      WSClient.on('DOWNLOAD_READY', (msg) => {
        Notifications.success('DOWNLOAD READY', msg.filename || '');
      });
    },
  };

  fetch('/version.json').then(r => r.json()).then(v => {
    const el = document.getElementById('footer-version');
    if (!el) return;
    const short = v.commit !== 'unknown' ? v.commit.slice(0, 7) : 'dev';
    const date = v.time !== 'unknown' ? new Date(v.time).toISOString().slice(0, 10) : '';
    el.textContent = date ? `${short} · ${date}` : short;
  }).catch(() => {});

  boot();
})();
