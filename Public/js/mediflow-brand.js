/* MediFlow — Brand injection (original) */
(function () {
  const ICON = '/assets/mediflow-logo-mark.png';

  function injectIcon(el) {
    if (!el || el.dataset.mfBrand) return;
    el.dataset.mfBrand = '1';
    el.textContent = '';
    const img = document.createElement('img');
    img.src = ICON;
    img.alt = '';
    img.className = 'mf-logo-img';
    img.setAttribute('aria-hidden', 'true');
    el.appendChild(img);
  }

  function initBrand() {
    document.querySelectorAll('.logo-icon, .brand-icon').forEach(injectIcon);
    document.querySelectorAll('[data-mf-logo-full]').forEach(el => {
      if (el.dataset.mfBrand) return;
      el.dataset.mfBrand = '1';
      const img = document.createElement('img');
      img.src = '/assets/mediflow-logo-full.png';
      img.alt = 'MediFlow — Your own Pharmacy';
      img.className = 'brand-logo-full';
      el.appendChild(img);
    });
    document.querySelectorAll('[data-mf-logo-mark]').forEach(el => {
      if (el.dataset.mfBrand) return;
      el.dataset.mfBrand = '1';
      const img = document.createElement('img');
      img.src = '/assets/mediflow-logo-mark.png';
      img.alt = 'MediFlow';
      img.className = 'brand-logo-mark';
      el.appendChild(img);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBrand);
  } else {
    initBrand();
  }
})();


/* MediFlow — Active-session suspension watcher (new)
 *
 * Runs on every page that includes mediflow-brand.js
 * (i.e. every page in the app, since they all already load it).
 *
 * - Polls /me every 30s and on tab refocus
 * - Wraps window.fetch to catch any 403 + {suspended:true}
 *   response from the existing requireOwner middleware
 * - On detection: destroys session + shows the shared
 *   suspension screen (same UI as login)
 *
 * Skipped for: admin pages (the admin never gets suspended
 * because suspension is a pharmacy-level concern). The admin
 * login uses a separate session key (adminLoggedIn) and is
 * served from admin.html, so this watcher does not run there
 * (admin.html does not include mediflow-brand.js).
 */
(function () {
  if (window.__mfSessionWatchInit) return;
  window.__mfSessionWatchInit = true;

  // Don't run on the login page itself (it has its own
  // showSuspendedView flow that triggers on /login response).
  // Also don't run on register / forgot-password.
  const path = (window.location.pathname || '').toLowerCase();
  const skipOn = ['/login.html', '/register.html', '/forgot-password.html', '/'];
  if (skipOn.includes(path)) return;

  // Don't run on the admin page (admin uses a separate
  // session and is not subject to pharmacy suspension).
  if (path.endsWith('admin.html') || path.startsWith('/admin')) return;

  const POLL_MS = 30000;
  let pollTimer = null;
  let suspendedShown = false;

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    window.__mfSuspendStopPolling = function () { /* already no-op */ };
  }
  window.__mfSuspendStopPolling = stopPolling;

  // ── Lazy-load the suspension component on first need ───
  function ensureSuspensionLoaded() {
    return new Promise((resolve) => {
      if (window.MediFlowSuspension) return resolve();
      const s = document.createElement('script');
      s.src = '/js/mediflow-suspension.js';
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.head.appendChild(s);
    });
  }

  // ── Trigger on detection ───────────────────────────────
  async function trigger(reason) {
    if (suspendedShown) return;
    suspendedShown = true;
    await ensureSuspensionLoaded();
    if (window.MediFlowSuspension) {
      window.MediFlowSuspension.show(reason || 'Access to MediFlow services is currently restricted.');
    }
  }

  // ── 1) Poll /me every 30s + on visibility change ──────
  async function checkMe() {
    if (suspendedShown) return;
    try {
      const r = await fetch('/me', { credentials: 'same-origin' });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.loggedIn && d.suspended === true) {
        await trigger(d.suspensionReason);
      }
    } catch (_) { /* network blip — try again next tick */ }
  }

  function startPolling() {
    if (pollTimer) return;
    // First check after a short delay (let the page finish
    // loading its own data first; we don't want to race the
    // page's primary /me call in checkAuth()).
    setTimeout(checkMe, 2000);
    pollTimer = setInterval(checkMe, POLL_MS);
  }

  // Also check when the tab becomes visible (user switches
  // back to MediFlow after a long break) — this catches
  // suspension that happened >30s ago without needing a tighter
  // poll interval.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkMe();
  });

  // ── 2) Wrap window.fetch to catch 403 + suspended ─────
  // This catches the case where the user clicks a button that
  // hits a protected API (e.g. Billing → /bill, Inventory →
  // /medicines) and gets an instant suspension response.
  // requireOwner middleware already returns this shape; we
  // just need to surface it.
  if (!window.__mfFetchWrapped) {
    window.__mfFetchWrapped = true;
    const origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const res = await origFetch(...args);
      try {
        if (res.status === 403 && res.headers.get('content-type')?.includes('application/json')) {
          const clone = res.clone();
          const data = await clone.json().catch(() => null);
          if (data && data.suspended === true) {
            await trigger(data.reason);
          }
        }
      } catch (_) { /* ignore inspection errors */ }
      return res;
    };
  }

  // ── Boot ───────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPolling);
  } else {
    startPolling();
  }
})();
