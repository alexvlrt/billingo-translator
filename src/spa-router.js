// src/spa-router.js
// Detects SPA route changes and invokes callback(location.pathname) debounced.
//
// A content script runs in an isolated JS world (Firefox Xray / Chrome isolated
// world), so monkey-patching the page's history.pushState does NOT intercept the
// page's own navigations — the patch only affects our world's view. Detection
// therefore polls location.pathname (a read that is always accurate from any
// world); popstate + the pushState patch are kept as best-effort fast paths for
// contexts where they do fire. Plain IIFE.

(function () {
  function onRouteChange(callback, opts) {
    const win = (opts && opts.window) || globalThis;
    const debounceMs = (opts && opts.debounceMs) != null ? opts.debounceMs : 150;
    const pollMs = (opts && opts.pollMs) != null ? opts.pollMs : 400;
    const history = win.history;
    let timer = null;
    let last = win.location.pathname;

    // Fire only when the path actually changed (dedupes poll vs. popstate vs.
    // pushState all noticing the same navigation), debounced to the latest path.
    function check() {
      const now = win.location.pathname;
      if (now === last) return;
      last = now;
      if (timer) win.clearTimeout(timer);
      timer = win.setTimeout(() => { timer = null; callback(now); }, debounceMs);
    }

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...args) { const r = origPush.apply(this, args); check(); return r; };
    history.replaceState = function (...args) { const r = origReplace.apply(this, args); check(); return r; };
    win.addEventListener('popstate', check);
    const poll = win.setInterval(check, pollMs); // the reliable, cross-world path

    return function teardown() {
      history.pushState = origPush;
      history.replaceState = origReplace;
      win.removeEventListener('popstate', check);
      win.clearInterval(poll);
      if (timer) win.clearTimeout(timer);
    };
  }

  globalThis.BillingoTranslator = globalThis.BillingoTranslator || {};
  globalThis.BillingoTranslator.onRouteChange = onRouteChange;
})();
