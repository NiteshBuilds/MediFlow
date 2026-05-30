/* MediFlow — inject logo icon wherever .logo-icon / .brand-icon exists */
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
