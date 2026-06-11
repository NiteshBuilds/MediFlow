/* ═══════════════════════════════════════════════════════════
   Expired Medicines — page logic
   - Loads from /api/expired-medicines (server-side filtered)
   - Instant client-side search by name OR barcode
   - Default sort: most recently expired first (server already
     returns them in that order, but we re-sort defensively)
   ═══════════════════════════════════════════════════════════ */

let _allItems = [];      // raw from server
let _filtered = [];      // current visible list (after search)
let _query    = '';      // current search query (lowercased)

async function checkAuth() {
  try {
    const d = await fetch('/me').then(r => r.json());
    if (!d.loggedIn) { window.location.href = '/login.html'; return; }
    document.getElementById('user-name-label').textContent = d.name;
    document.getElementById('user-avatar').textContent     = d.name.charAt(0).toUpperCase();
  } catch (_) {}
}

async function doLogout() {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Server returns ISO date; "10 June 2026" format */
function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
}

/* "15 days ago" / "1 day ago" / "today" */
function daysAgoLabel(n) {
  if (n <= 0)  return 'today';
  if (n === 1) return '1 day ago';
  return `${n} days ago`;
}

async function loadExpired() {
  const host   = document.getElementById('list-host');
  const banner = document.getElementById('banner-host');
  const meta   = document.getElementById('result-meta');

  host.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-title">Loading expired batches…</div></div>';
  meta.textContent = 'Loading…';

  try {
    const res  = await fetch('/api/expired-medicines', { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load.');

    _allItems = Array.isArray(data.items) ? data.items : [];

    // Defensive re-sort: oldest expiryDate first = "most recently expired"
    _allItems.sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));

    updateSummary();
    renderBanner();
    applyFilter();
  } catch (err) {
    host.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">Could not load expired medicines</div><div class="empty-text">${esc(err.message)}</div></div>`;
    meta.textContent = 'Error';
  }
}

function updateSummary() {
  const count = _allItems.length;
  const units = _allItems.reduce((sum, it) => sum + (Number(it.stock) || 0), 0);
  document.getElementById('chip-count').textContent = count;
  document.getElementById('chip-units').textContent = units;
}

function renderBanner() {
  const banner = document.getElementById('banner-host');
  if (!_allItems.length) {
    // Nothing expired — keep the page calm, no red banner
    banner.innerHTML = '';
    return;
  }
  // Pick the single most-urgent item: longest-expired with highest stock
  const worst = [..._allItems].sort((a, b) => {
    if (a.daysSinceExpiry !== b.daysSinceExpiry) return b.daysSinceExpiry - a.daysSinceExpiry;
    return b.stock - a.stock;
  })[0];

  const expStr = formatDate(worst.expiryDate);
  banner.innerHTML = `
    <div class="danger-banner">
      <div class="db-icon">❌</div>
      <div class="db-body">
        <div class="db-title">Expired:</div>
        <div class="db-text">
          <strong>${esc(worst.name)}</strong> — <strong>${esc(worst.batchLabel)}</strong><br/>
          <strong>${worst.stock} unit${worst.stock !== 1 ? 's' : ''}</strong> expired on <strong>${esc(expStr)}</strong>${worst.daysSinceExpiry > 0 ? ` (${daysAgoLabel(worst.daysSinceExpiry)})` : ''}. Remove from shelf immediately.
        </div>
      </div>
    </div>`;
}

function applyFilter() {
  _query = (document.getElementById('search-input').value || '').trim().toLowerCase();
  if (!_query) {
    _filtered = _allItems.slice();
  } else {
    _filtered = _allItems.filter(it => {
      const name    = (it.name    || '').toLowerCase();
      const barcode = (it.barcode || '').toLowerCase();
      return name.includes(_query) || barcode.includes(_query);
    });
  }
  renderList();
}

function renderList() {
  const host = document.getElementById('list-host');
  const meta = document.getElementById('result-meta');

  // Update the result counter
  if (!_query) {
    meta.innerHTML = `Showing <strong>${_allItems.length}</strong> batch${_allItems.length !== 1 ? 'es' : ''}`;
  } else {
    meta.innerHTML = `Showing <strong>${_filtered.length}</strong> of <strong>${_allItems.length}</strong>`;
  }

  // Empty filter result (but server had data)
  if (_allItems.length > 0 && _filtered.length === 0) {
    host.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No matches for "${esc(_query)}"</div>
        <div class="empty-text">Try a different medicine name or barcode.</div>
      </div>`;
    return;
  }

  // No expired batches at all — friendly "all clear" state
  if (_allItems.length === 0) {
    host.innerHTML = `
      <div class="empty-state ok">
        <div class="empty-icon">✅</div>
        <div class="empty-title">No expired batches in inventory</div>
        <div class="empty-text">All your medicine batches are still within their expiry date. Nice work!</div>
      </div>`;
    return;
  }

  // Render cards
  const cards = _filtered.map(it => {
    const expStr      = formatDate(it.expiryDate);
    const daysAgoStr  = daysAgoLabel(it.daysSinceExpiry);
    const stockLabel  = `${it.stock} unit${it.stock !== 1 ? 's' : ''}`;
    return `
      <div class="batch-card">
        <div class="bc-left">
          <div class="bc-name">${esc(it.name)}</div>
          <div class="bc-batch">${esc(it.batchLabel)} is expired</div>
          <div class="bc-meta">
            <div class="bc-meta-item">
              <div class="bc-meta-label">Expired on</div>
              <div class="bc-meta-value danger">${esc(expStr)}</div>
            </div>
            <div class="bc-meta-item">
              <div class="bc-meta-label">Expired</div>
              <div class="bc-meta-value danger">${esc(daysAgoStr)}</div>
            </div>
            <div class="bc-meta-item">
              <div class="bc-meta-label">Barcode</div>
              <div class="bc-meta-value" style="font-family:monospace">${esc(it.barcode)}</div>
            </div>
          </div>
        </div>
        <div class="bc-right">
          <div class="stock-badge"><span class="sb-num">${it.stock}</span> ${it.stock === 1 ? 'unit' : 'units'} remaining</div>
          <div class="days-badge">⏳ ${esc(daysAgoStr)}</div>
        </div>
      </div>`;
  }).join('');

  host.innerHTML = `<div class="batch-list">${cards}</div>`;
}

/* Wire up: instant search, debounce-free for snappy feel */
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  loadExpired();

  const search = document.getElementById('search-input');
  if (search) search.addEventListener('input', applyFilter);
});
