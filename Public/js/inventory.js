/* ═══════════════════════════════════════════════════════════
   Manage Inventory — page logic
   - Loads medicines from /medicines (already sorted A→Z server-side)
   - Instant client-side search by name OR barcode
   - Click medicine card to expand batches
   - Delete individual batch via /medicine-batch/:barcode/:batchId
   - Auto-cleanup handled server-side: if the last batch of a
     medicine is deleted, the parent medicine is removed too.
   ═══════════════════════════════════════════════════════════ */

let _allMeds    = [];   // raw from server
let _filtered   = [];   // current visible list
let _query      = '';   // lowercase search term
let _expanded   = new Set();  // barcodes currently expanded

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

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/* Server already returns medicines sorted by name ASC, but we
   re-sort defensively in case the route order ever changes. */
function sortAZ(list) {
  return [...list].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base' })
  );
}

async function loadInventory(showSpinner) {
  const host = document.getElementById('list-host');
  const meta = document.getElementById('result-meta');

  if (showSpinner) meta.textContent = 'Refreshing…';
  try {
    const res  = await fetch('/medicines', { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load.');

    _allMeds = sortAZ(Array.isArray(data) ? data : []);
    // If a previously-expanded medicine is gone (deleted because its
    // last batch was removed), drop it from the expansion set.
    const existingBarcodes = new Set(_allMeds.map(m => m.barcode));
    for (const bc of [..._expanded]) if (!existingBarcodes.has(bc)) _expanded.delete(bc);

    updateSummary();
    applyFilter();
  } catch (err) {
    host.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">Could not load inventory</div><div class="empty-text">${esc(err.message)}</div></div>`;
    meta.textContent = 'Error';
  }
}

function updateSummary() {
  const medCount  = _allMeds.length;
  let batchCount = 0, totalStock = 0;
  for (const m of _allMeds) {
    if (Array.isArray(m.batches)) {
      batchCount += m.batches.length;
      for (const b of m.batches) totalStock += Number(b.stock) || 0;
    }
  }
  document.getElementById('chip-meds').textContent    = medCount;
  document.getElementById('chip-batches').textContent = batchCount;
  document.getElementById('chip-stock').textContent   = totalStock;
}

function applyFilter() {
  _query = (document.getElementById('search-input').value || '').trim().toLowerCase();
  if (!_query) {
    _filtered = _allMeds.slice();
  } else {
    _filtered = _allMeds.filter(m => {
      const name    = (m.name    || '').toLowerCase();
      const barcode = (m.barcode || '').toLowerCase();
      return name.includes(_query) || barcode.includes(_query);
    });
  }
  renderList();
}

function renderList() {
  const host = document.getElementById('list-host');
  const meta = document.getElementById('result-meta');

  if (!_query) {
    meta.innerHTML = `Showing <strong>${_allMeds.length}</strong> medicine${_allMeds.length !== 1 ? 's' : ''}`;
  } else {
    meta.innerHTML = `Showing <strong>${_filtered.length}</strong> of <strong>${_allMeds.length}</strong>`;
  }

  // No medicines at all
  if (_allMeds.length === 0) {
    host.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-title">Your inventory is empty</div>
        <div class="empty-text">Add medicines from the "Add Medicine" page to get started.</div>
      </div>`;
    return;
  }

  // Search returned nothing
  if (_filtered.length === 0) {
    host.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No matches for "${esc(_query)}"</div>
        <div class="empty-text">Try a different medicine name or barcode.</div>
      </div>`;
    return;
  }

  host.innerHTML = `<div class="med-list">${_filtered.map(renderMedCard).join('')}</div>`;
}

function renderMedCard(m) {
  const isExpanded = _expanded.has(m.barcode);
  const batches    = Array.isArray(m.batches) ? m.batches : [];
  const batchCount = batches.length;
  const totalStock = batches.reduce((s, b) => s + (Number(b.stock) || 0), 0);

  return `
    <div class="med-card${isExpanded ? ' expanded' : ''}" data-barcode="${esc(m.barcode)}">
      <div class="med-head" onclick="toggleExpand('${esc(m.barcode)}')">
        <div class="med-left">
          <div class="med-pill">💊</div>
          <div class="med-info">
            <div class="med-name">${esc(m.name)}</div>
            <div class="med-meta">
              <span style="font-family:monospace">${esc(m.barcode)}</span>
              <span class="sep">·</span>
              <span>₹${Number(m.price).toFixed(2)} selling price</span>
            </div>
          </div>
        </div>
        <div class="med-right">
          <div class="med-stats">
            <span class="stat-num">${batchCount}</span> batch${batchCount !== 1 ? 'es' : ''}
            <span style="margin:0 .25rem;color:var(--border-dk)">|</span>
            <span class="stat-num">${totalStock}</span> units
          </div>
          <div class="expand-icon">▾</div>
        </div>
      </div>
      <div class="med-batches">
        ${batches.length === 0
          ? `<div style="text-align:center;padding:1.5rem;color:var(--muted);font-size:.82rem">No batches in this medicine.</div>`
          : `<div class="batch-grid">${batches.map(b => renderBatchCard(m, b)).join('')}</div>`}
      </div>
    </div>`;
}

function renderBatchCard(med, b) {
  const stock   = Number(b.stock) || 0;
  const expDate = new Date(b.expiryDate);
  const now     = new Date();
  const daysToExp = Math.ceil((expDate - now) / 86400000);

  // Visual category by state
  let stateClass = '';
  if (stock === 0)            stateClass = 'empty-stock';
  else if (daysToExp < 0)     stateClass = 'expired-stock';
  else if (daysToExp <= 30)   stateClass = 'expiring';

  const stockClass = stock === 0 ? 'out' : (stock < 5 ? 'low' : '');
  const stockLabel = stock === 0 ? '0 · out' : stock;

  const expStr    = formatDate(b.expiryDate);
  const createdStr = b.addedAt ? formatDate(b.addedAt) : '—';
  const label     = b.batchLabel || 'Unlabelled';

  return `
    <div class="batch-card ${stateClass}">
      <div class="bc-top">
        <div class="bc-label">${esc(label)}</div>
        <div class="bc-stock ${stockClass}">${stockLabel} unit${stock !== 1 ? 's' : ''}</div>
      </div>
      <div class="bc-row"><span class="k">Expiry</span><span class="v ${daysToExp < 0 ? 'danger' : (daysToExp <= 30 ? 'amber' : '')}">${esc(expStr)}</span></div>
      <div class="bc-row"><span class="k">Selling Price</span><span class="v">₹${Number(med.price).toFixed(2)}</span></div>
      <div class="bc-row"><span class="k">Created</span><span class="v">${esc(createdStr)}</span></div>
      <button class="bc-delete" onclick="askDeleteBatch('${esc(med.barcode)}','${esc(b._id)}','${esc(med.name)}','${esc(label)}',${stock})">🗑 Delete Batch</button>
    </div>`;
}

function toggleExpand(barcode) {
  if (_expanded.has(barcode)) _expanded.delete(barcode);
  else _expanded.add(barcode);
  // Re-render only the affected card for snappy feel
  const card = document.querySelector(`.med-card[data-barcode="${cssEscape(barcode)}"]`);
  if (card) {
    const med = _allMeds.find(m => m.barcode === barcode);
    if (med) card.outerHTML = renderMedCard(med);
  }
}

function cssEscape(s) {
  // Minimal CSS attr-value escape for quotes/backslashes
  return String(s).replace(/(["\\])/g, '\\$1');
}

/* ── Delete confirmation flow ── */
let _pendingDelete = null;   // { barcode, batchId }

function askDeleteBatch(barcode, batchId, medName, batchLabel, stock) {
  _pendingDelete = { barcode, batchId };
  document.getElementById('dm-batch-label').textContent = batchLabel;
  document.getElementById('dm-medicine').textContent    = medName;
  document.getElementById('dm-batch').textContent       = batchLabel;
  document.getElementById('dm-stock').textContent       = `${stock} unit${stock !== 1 ? 's' : ''}`;
  const modal = document.getElementById('delete-modal');
  modal.style.display = 'flex';
  // Wire the confirm button (replace any prior handler)
  const btn = document.getElementById('dm-confirm-btn');
  btn.onclick = confirmDeleteBatch;
  btn.disabled = false;
  btn.textContent = '🗑️ Delete Batch';
}

function closeDeleteModal() {
  document.getElementById('delete-modal').style.display = 'none';
  _pendingDelete = null;
}

function closeDeleteModalIfBackdrop(e) {
  if (e.target === document.getElementById('delete-modal')) closeDeleteModal();
}

async function confirmDeleteBatch() {
  if (!_pendingDelete) return;
  const { barcode, batchId } = _pendingDelete;
  const btn = document.getElementById('dm-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';

  try {
    const res  = await fetch(`/medicine-batch/${encodeURIComponent(barcode)}/${encodeURIComponent(batchId)}`, {
      method:  'DELETE',
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed.');

    // Collapse the card optimistically — re-render will refresh data
    _expanded.delete(barcode);
    closeDeleteModal();
    toast(data.medicineRemoved ? 'info' : 'ok',
          data.message || 'Batch deleted.');

    // Re-load from server to reflect auto-cleanup and re-labelling
    await loadInventory();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '🗑️ Delete Batch';
    toast('err', err.message || 'Could not delete batch.');
  }
}

/* ── Toast helper ── */
function toast(kind, text) {
  const host = document.getElementById('toast-host');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

/* ── Wire up: search, escape-to-close, click-outside-modal ── */
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  loadInventory();

  const search = document.getElementById('search-input');
  if (search) search.addEventListener('input', applyFilter);

  const modal = document.getElementById('delete-modal');
  if (modal) modal.addEventListener('click', closeDeleteModalIfBackdrop);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDeleteModal();
  });
});
