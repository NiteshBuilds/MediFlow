/* MediFlow — Reusable "Account Suspended" full-screen component
 *
 * Source of truth: lifted verbatim from login.html so the
 * already-logged-in user sees the EXACT same screen as the
 * login-time suspension screen. No new design, no new modal.
 *
 * Triggered by:
 *   1. /me polling on every protected page (via mediflow-brand.js)
 *   2. Any fetch() that returns 403 + { suspended: true } (via mediflow-brand.js)
 *
 * On trigger: destroys the session via POST /logout, then shows
 * the screen with the stored reason.
 */
(function () {
  if (window.__mfSuspensionLoaded) return;
  window.__mfSuspensionLoaded = true;

  const DEFAULT_REASON = 'Access to MediFlow services is currently restricted.';

  // ── Inject CSS once ────────────────────────────────────
  // Identical to the CSS block in login.html for #suspended-view
  function injectCSS() {
    if (document.getElementById('mf-suspension-css')) return;
    const style = document.createElement('style');
    style.id = 'mf-suspension-css';
    style.textContent = `
      body.mf-suspended .sidebar,
      body.mf-suspended .main-wrap,
      body.mf-suspended .topbar,
      body.mf-suspended .login-wrap { display: none !important; }
      #mf-suspended-view{
        position:fixed; inset:0; z-index:9999;
        display:none; align-items:center; justify-content:center;
        padding:1.5rem; background:var(--bg, #f0f4f5);
        font-family:'Plus Jakarta Sans',sans-serif;
        overflow:auto;
      }
      #mf-suspended-view.show{ display:flex; }
      #mf-suspended-view .mf-sus-card{
        width:100%; max-width:520px; background:#fff;
        border:1px solid #d4e6e7; border-radius:20px;
        box-shadow:0 12px 40px rgba(13,107,110,.18);
        overflow:hidden; animation:mfSusPopIn .35s ease;
      }
      @keyframes mfSusPopIn{
        from{opacity:0;transform:scale(.97) translateY(10px)}
        to  {opacity:1;transform:scale(1) translateY(0)}
      }
      #mf-suspended-view .mf-sus-head{
        background:linear-gradient(160deg,#a02020 0%,#c0392b 60%,#d4503f 100%);
        padding:1.7rem 2rem 1.4rem; text-align:center; position:relative; overflow:hidden;
      }
      #mf-suspended-view .mf-sus-head::before{
        content:''; position:absolute; inset:0;
        background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),
                         linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);
        background-size:24px 24px; pointer-events:none;
      }
      #mf-suspended-view .mf-sus-head-icon{
        width:64px; height:64px; background:rgba(255,255,255,.15);
        border:2px solid rgba(255,255,255,.25); border-radius:50%;
        display:flex; align-items:center; justify-content:center;
        margin:0 auto .85rem; font-size:1.8rem; position:relative; z-index:1;
      }
      #mf-suspended-view .mf-sus-head-title{
        font-family:'Sora',sans-serif; font-size:1.15rem; font-weight:700;
        color:#fff; position:relative; z-index:1; line-height:1.3;
      }
      #mf-suspended-view .mf-sus-head-sub{
        font-size:.75rem; color:rgba(255,255,255,.7);
        margin-top:.3rem; position:relative; z-index:1;
      }
      #mf-suspended-view .mf-sus-body{ padding:1.6rem 2rem 1.8rem; }
      #mf-suspended-view .mf-sus-msg{
        font-size:.85rem; color:#3a5a5c; line-height:1.6;
        margin-bottom:1rem; text-align:center;
      }
      #mf-suspended-view .mf-sus-reason-box{
        background:#fff5f5; border:1.5px solid #f5c6c2;
        border-radius:8px; padding:.85rem 1rem; margin-bottom:.9rem;
      }
      #mf-suspended-view .mf-sus-reason-lbl{
        font-size:.65rem; font-weight:800; text-transform:uppercase;
        letter-spacing:.08em; color:#c0392b; margin-bottom:.3rem;
      }
      #mf-suspended-view .mf-sus-reason-val{
        font-size:.88rem; color:#7a1a1a; font-weight:700; line-height:1.4;
      }
      #mf-suspended-view .mf-sus-detail{
        font-size:.75rem; color:#7a9ea0; text-align:center;
        line-height:1.55; margin-bottom:1.3rem; padding:0 .3rem;
      }
      #mf-suspended-view .mf-sus-return{
        width:100%; padding:.75rem; background:#0d6b6e; color:#fff;
        border:none; border-radius:8px; font-size:.9rem; font-weight:700;
        font-family:inherit; cursor:pointer; transition:all .18s;
        box-shadow:0 2px 8px rgba(13,107,110,.25);
        display:flex; align-items:center; justify-content:center; gap:.4rem;
      }
      #mf-suspended-view .mf-sus-return:hover{
        background:#0f8a8e; transform:translateY(-1px);
        box-shadow:0 4px 14px rgba(13,107,110,.3);
      }
    `;
    document.head.appendChild(style);
  }

  // ── Build the view once ────────────────────────────────
  function buildView() {
    if (document.getElementById('mf-suspended-view')) return;
    const wrap = document.createElement('div');
    wrap.id = 'mf-suspended-view';
    wrap.innerHTML = `
      <div class="mf-sus-card">
        <div class="mf-sus-head">
          <div class="mf-sus-head-icon">⏸</div>
          <div class="mf-sus-head-title">Account Temporarily Suspended</div>
          <div class="mf-sus-head-sub">Access to MediFlow has been restricted</div>
        </div>
        <div class="mf-sus-body">
          <div class="mf-sus-msg">
            Your MediFlow pharmacy account has been temporarily suspended by the system administrator.
          </div>
          <div class="mf-sus-reason-box">
            <div class="mf-sus-reason-lbl">Reason</div>
            <div class="mf-sus-reason-val" id="mf-suspended-reason-text">
              Access to MediFlow services is currently restricted.
            </div>
          </div>
          <div class="mf-sus-detail">
            If you believe this suspension was applied in error or require further clarification, please contact the MediFlow administration team.<br/><br/>
            Thank you for your understanding and cooperation.
          </div>
          <button class="mf-sus-return" id="mf-suspended-return-btn">← Return to Login</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    document.getElementById('mf-suspended-return-btn').addEventListener('click', returnToLogin);
  }

  // ── Public: show screen + destroy session ─────────────
  // The reason passed in here MUST come from the server
  // (user.suspensionReason field) — never from the client.
  async function show(reason) {
    injectCSS();
    if (!document.body) {
      // Body not ready yet — wait
      await new Promise(r => {
        if (document.body) return r();
        document.addEventListener('DOMContentLoaded', r, { once: true });
      });
    }
    buildView();
    document.body.classList.add('mf-suspended');

    // Set reason text BEFORE destroying session so the user
    // sees the message even if logout is slow.
    const reasonEl = document.getElementById('mf-suspended-reason-text');
    if (reasonEl) reasonEl.textContent = reason || DEFAULT_REASON;

    // Show the screen immediately
    const view = document.getElementById('mf-suspended-view');
    if (view) view.classList.add('show');

    // Stop polling — we don't want to re-trigger once shown
    if (window.__mfSuspendStopPolling) window.__mfSuspendStopPolling();

    // Destroy the session on the server. Best-effort — even if
    // this fails, the UI is locked and the user must return
    // to login. We use fetch directly (not window.fetch wrapper)
    // to avoid recursion into our own 403+suspended handler.
    try {
      await fetch('/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (_) { /* noop */ }
  }

  // ── Public: hide + redirect to login ──────────────────
  async function returnToLogin() {
    try { await fetch('/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) {}
    window.location.href = '/login.html';
  }

  // Expose globally
  window.MediFlowSuspension = { show, returnToLogin };

  // ── Backwards-compat aliases ──────────────────────────
  // login.html uses window.showSuspendedView / returnToLogin
  // from its own inline script. We expose them here too so
  // the shared file is drop-in safe on the login page.
  window.showSuspendedView = show;
  window.returnToLogin     = returnToLogin;
})();
