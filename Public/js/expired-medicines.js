/* ═══════════════════════════════════════════════════════════
   Expired Medicines — page data loader
   Contract (matches the inline script in expired-medicines.html):
     - Fetches /api/expired-medicines
     - Updates #chip-count, #chip-units, #banner-host
     - Hands the items array to window.__expiredSetItems(items)
       so the existing inline renderItem()/render() logic
       (Total Medicines card pattern) draws the list.
   No business logic lives here — purely loads + wires data.
   ═══════════════════════════════════════════════════════════ */

(function () {
  async function loadExpiredMedicines() {
    const chipCount = document.getElementById('chip-count');
    const chipUnits = document.getElementById('chip-units');
    const banner    = document.getElementById('banner-host');
    const host       = document.getElementById('list-host');
    const meta       = document.getElementById('result-meta');

    try {
      const res  = await fetch('/api/expired-medicines', { credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load expired medicines.');

      const items = Array.isArray(data.items) ? data.items : [];

      // ── Update summary chips ──
      const totalUnits = items.reduce((sum, m) => sum + (Number(m.stock ?? m.units) || 0), 0);
      if (chipCount) chipCount.textContent = items.length;
      if (chipUnits) chipUnits.textContent = totalUnits;

      // ── Optional banner when there ARE expired batches ──
      if (banner) {
        banner.innerHTML = items.length
          ? `<div class="empty-state" style="display:none"></div>` // no extra banner needed; cards carry the warning visually
          : '';
      }

      // Normalise field name: API returns `stock`, renderItem() in the
      // inline script expects `m.units` — map it without touching the
      // API or the renderer's existing logic.
      const normalised = items.map(m => ({
        ...m,
        units: m.units ?? m.stock,
      }));

      // ── Hand off to the existing renderer ──
      if (typeof window.__expiredSetItems === 'function') {
        window.__expiredSetItems(normalised);
      }
    } catch (err) {
      if (host) {
        host.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">Could not load expired medicines.</div><div class="empty-text">${String(err.message || err).replace(/</g, '&lt;')}</div></div>`;
      }
      if (meta) meta.textContent = 'Error';
      if (chipCount) chipCount.textContent = '0';
      if (chipUnits) chipUnits.textContent = '0';
    }
  }

  loadExpiredMedicines();
})();
