// Loaded in <head> (classic script) so the theme is applied before first paint: no flash.
(function () {
  var KEY = 'zedpdf-theme';
  var root = document.documentElement;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function apply(pref) {
    var mode = pref === 'light' || pref === 'dark' ? pref : mq.matches ? 'dark' : 'light';
    root.dataset.theme = mode;
    root.dataset.themePref = pref || 'system';
  }
  apply(stored());
  mq.addEventListener('change', function () { if (!stored()) apply(null); });
  window.zedTheme = {
    toggle: function () {
      var next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next);
    },
    reset: function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      apply(null);
    },
  };
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (t) window.zedTheme.toggle();
    var c = e.target.closest && e.target.closest('[data-copy]');
    if (c) {
      var src = document.querySelector(c.getAttribute('data-copy'));
      var text = src ? src.innerText : c.getAttribute('data-copy-text');
      if (navigator.clipboard && text) navigator.clipboard.writeText(text.trim()).then(function () {
        var old = c.textContent;
        c.textContent = 'Copied';
        setTimeout(function () { c.textContent = old; }, 1400);
      });
    }
  });
})();
