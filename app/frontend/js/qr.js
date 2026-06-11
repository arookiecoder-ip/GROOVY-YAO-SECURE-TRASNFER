const QRModule = {
  async show(fileId) {
    const overlay = document.getElementById('qr-overlay');
    const img = document.getElementById('qr-image');
    const url = document.getElementById('qr-url');

    img.innerHTML = '<div style="color:var(--color-text-dim);padding:40px">LOADING...</div>';
    url.textContent = '';
    const close = () => Utils.closeModal(overlay);
    Utils.openModal(overlay, close);

    try {
      const res = await fetch(`/api/files/${fileId}/qr`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('QR generation failed');
      const data = await res.json();
      img.innerHTML = `<img src="${data.dataUrl}" alt="QR Code" />`;
      url.textContent = data.downloadUrl;
    } catch (err) {
      img.innerHTML = `<div style="color:var(--color-red)">${Utils.escape(err.message)}</div>`;
    }

    const copyBtn = document.getElementById('qr-copy-link');
    copyBtn.onclick = () => {
      Utils.copyToClipboard(document.getElementById('qr-url').textContent);
      const orig = copyBtn.textContent;
      copyBtn.textContent = 'COPIED!';
      setTimeout(() => { copyBtn.textContent = orig; }, 1500);
    };
    document.getElementById('qr-close').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
  },
};
