// Runs before first paint (classic script, CSP-safe) so the saved theme never flashes.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('duet.settings') || '{}');
    if (s.theme === 'light' || s.theme === 'dark') document.documentElement.setAttribute('data-theme', s.theme);
  } catch (e) { /* default to system */ }
})();
