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
    openUlDialog: null,
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
          if (view === 'upload-links') UploadLinksModule.init();
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

      // Upload link dialog
      const ulDialog = document.getElementById('upload-link-dialog');
      const ulOpts = ['single', 'multi', 'unlimited'];
      let ulSelected = 'single';

      function openUlDialog() {
        ulSelected = 'single';
        document.getElementById('ul-opt-single').classList.add('selected');
        document.getElementById('ul-opt-multi').classList.remove('selected');
        document.getElementById('ul-opt-unlimited').classList.remove('selected');
        ulDialog.classList.remove('hidden');
      }
      function closeUlDialog() { ulDialog.classList.add('hidden'); }

      document.getElementById('ul-dialog-close').addEventListener('click', closeUlDialog);
      ulDialog.addEventListener('click', (e) => { if (e.target === ulDialog) closeUlDialog(); });

      ['single', 'multi', 'unlimited'].forEach((type) => {
        document.getElementById(`ul-opt-${type}`).addEventListener('click', () => {
          ulSelected = type;
          ['single', 'multi', 'unlimited'].forEach((t) =>
            document.getElementById(`ul-opt-${t}`).classList.toggle('selected', t === type)
          );
        });
      });

      document.getElementById('ul-dialog-create').addEventListener('click', async () => {
        let max_uses = 1;
        if (ulSelected === 'unlimited') max_uses = 0;
        else if (ulSelected === 'multi') {
          max_uses = parseInt(document.getElementById('ul-multi-count').value, 10) || 10;
        }
        try {
          const res = await fetch('/api/upload-requests', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ max_uses }),
          });
          if (!res.ok) throw new Error('Failed to create link');
          const { url } = await res.json();
          Utils.copyToClipboard(url);
          Notifications.success('UPLOAD LINK COPIED', url);
          closeUlDialog();
          if (typeof UploadLinksModule !== 'undefined') UploadLinksModule.refresh();
        } catch (err) {
          Notifications.error('Failed', err.message);
        }
      });

      AppMain.openUlDialog = openUlDialog;

      // Create one-time upload link
      document.getElementById('btn-create-upload-link').addEventListener('click', openUlDialog);

      // Logout
      document.getElementById('btn-logout').addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        location.reload();
      });

      // Hamburger / mobile drawer
      const hamburger = document.getElementById('btn-hamburger');
      const drawer = document.getElementById('mobile-drawer');
      const backdrop = document.getElementById('drawer-backdrop');

      function openDrawer() {
        drawer.classList.add('open');
        backdrop.classList.add('open');
        hamburger.classList.add('open');
        hamburger.setAttribute('aria-expanded', 'true');
        drawer.setAttribute('aria-hidden', 'false');
      }
      function closeDrawer() {
        drawer.classList.remove('open');
        backdrop.classList.remove('open');
        hamburger.classList.remove('open');
        hamburger.setAttribute('aria-expanded', 'false');
        drawer.setAttribute('aria-hidden', 'true');
      }

      hamburger.addEventListener('click', () => drawer.classList.contains('open') ? closeDrawer() : openDrawer());
      backdrop.addEventListener('click', closeDrawer);
      document.getElementById('btn-drawer-close').addEventListener('click', closeDrawer);

      // Drawer nav mirrors main nav
      document.querySelectorAll('.drawer-nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
          document.querySelectorAll('.drawer-nav-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          const matchingNav = document.querySelector(`.nav-btn[data-view="${btn.dataset.view}"]`);
          if (matchingNav) matchingNav.classList.add('active');
          const view = btn.dataset.view;
          document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
          const el = document.getElementById(`view-${view}`);
          if (el) el.classList.add('active');
          if (view === 'history') HistoryModule.init();
          if (view === 'stats') StatsModule.init();
          if (view === 'upload-links') UploadLinksModule.init();
          closeDrawer();
        });
      });

      // Drawer theme button mirrors main theme button
      const drawerThemeBtn = document.getElementById('drawer-btn-theme');
      drawerThemeBtn.textContent = themeBtn.textContent;
      drawerThemeBtn.addEventListener('click', () => {
        themeBtn.click();
        drawerThemeBtn.textContent = themeBtn.textContent;
      });
      themeBtn.addEventListener('click', () => { drawerThemeBtn.textContent = themeBtn.textContent; });

      // Drawer upload link
      document.getElementById('drawer-btn-upload-link').addEventListener('click', () => {
        closeDrawer();
        openUlDialog();
      });

      // Drawer logout
      document.getElementById('drawer-btn-logout').addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        location.reload();
      });

      // Disk storage bar
      fetch('/api/stats', { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : null)
        .then(s => {
          if (!s || !s.disk) return;
          const pct = s.disk.total > 0 ? (s.disk.used / s.disk.total) * 100 : 0;
          const text = `${Utils.formatBytes(s.disk.used)} / ${Utils.formatBytes(s.disk.total)}`;
          const freeText = `${Utils.formatBytes(s.disk.free)} free`;

          const fill = document.getElementById('storage-bar-fill');
          const label = document.getElementById('storage-pct');
          const wrap = document.getElementById('header-storage');
          fill.style.width = pct.toFixed(1) + '%';
          fill.classList.toggle('warn', pct >= 75 && pct < 90);
          fill.classList.toggle('danger', pct >= 90);
          label.textContent = text;
          wrap.title = freeText;
          wrap.style.display = 'flex';

          const drawerFill = document.getElementById('drawer-storage-bar-fill');
          const drawerLabel = document.getElementById('drawer-storage-pct');
          const drawerWrap = document.getElementById('drawer-storage');
          drawerFill.style.width = pct.toFixed(1) + '%';
          drawerFill.classList.toggle('warn', pct >= 75 && pct < 90);
          drawerFill.classList.toggle('danger', pct >= 90);
          drawerLabel.textContent = text;
          drawerWrap.title = freeText;
          drawerWrap.style.display = 'flex';
        })
        .catch(() => {});

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
      WSClient.on('FILE_DELETED', () => FileManagerModule.refresh());
      WSClient.on('FILE_UPDATED', () => FileManagerModule.refresh());
      WSClient.on('FILE_ADDED', () => FileManagerModule.refresh());
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
