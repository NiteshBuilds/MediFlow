/* MediFlow — login splash with real logo + reveal animation */
(function () {
  const SPLASH_MS = 3200;

  function showMediFlowSplash(onDone) {
    if (document.getElementById('mf-splash')) {
      if (onDone) onDone();
      return;
    }

    const wrap = document.createElement('div');
    wrap.id = 'mf-splash';
    wrap.className = 'mf-splash';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-label', 'Loading MediFlow');
    wrap.innerHTML = `
      <div class="mf-splash-inner">
        <div class="mf-splash-logo-wrap">
          <div class="mf-splash-ring" aria-hidden="true"></div>
          <div class="mf-splash-ring mf-splash-ring-2" aria-hidden="true"></div>
          <img src="/assets/mediflow-logo-mark.png" alt="" class="mf-splash-logo-img"/>
        </div>
        <div class="mf-splash-title">MediFlow</div>
        <div class="mf-splash-tag">Your own Pharmacy</div>
      </div>`;

    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';

    setTimeout(() => {
      wrap.classList.add('hide');
      setTimeout(() => {
        wrap.remove();
        document.body.style.overflow = '';
        if (onDone) onDone();
      }, 520);
    }, SPLASH_MS);
  }

  window.showMediFlowSplash = showMediFlowSplash;

  function maybeShowPostLoginSplash() {
    if (sessionStorage.getItem('mediflowSplash') !== '1') return;
    sessionStorage.removeItem('mediflowSplash');
    showMediFlowSplash();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeShowPostLoginSplash);
  } else {
    maybeShowPostLoginSplash();
  }
})();
