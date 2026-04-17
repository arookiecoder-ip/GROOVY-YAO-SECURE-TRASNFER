const QRModule = {
  async show(fileId) {
    const overlay = document.getElementById('qr-overlay');
    const img = document.getElementById('qr-image');
    const url = document.getElementById('qr-url');

    img.innerHTML = '<div style="color:var(--color-text-dim);padding:40px">LOADING...</div>';
    url.textContent = '';
    overlay.classList.remove('hidden');

    try {
      const res = await fetch(`/api/files/${fileId}/qr`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('QR generation failed');
      const data = await res.json();
      img.innerHTML = `<img src="${data.dataUrl}" alt="QR Code" />`;
      url.textContent = data.downloadUrl;
    } catch (err) {
      img.innerHTML = `<div style="color:var(--color-red)">${Utils.escape(err.message)}</div>`;
    }

    document.getElementById('qr-close').onclick = () => overlay.classList.add('hidden');
    overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add('hidden'); };
  },
};
