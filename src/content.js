// src/content.js
// Entry point. Reads user lang preference, fetches dict via the shard loader,
// wires translator+walker, listens for popup messages.
//
// translator.js, dom-walker.js, shard-loader.js and spa-router.js are loaded
// BEFORE this file by the manifest's content_scripts.js array, so we access
// them via globalThis.BillingoTranslator.

(function () {
  // Gecko/Chrome API shim: Firefox exposes `browser`, Chrome exposes `chrome`.
  const api = globalThis.browser ?? globalThis.chrome;
  const { createTranslator, createStats, walkAndTranslate, installObserver,
          createShardLoader, onRouteChange } = globalThis.BillingoTranslator;

  // Module state (per-tab).
  let currentLang = 'hu';
  let currentTranslate = null;
  let currentStats = createStats();
  let currentObserver = null;
  let applySeq = 0;

  let loader = null;

  async function fetchShard(lang, shard) {
    const url = api.runtime.getURL(`dict/${lang}/${shard}.json`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`dict/${lang}/${shard}.json: ${res.status}`);
    return res.json();
  }

  // Fallback: the pre-P2 monolithic dict, used if shard loading fails.
  async function loadMonolithic(lang) {
    const res = await fetch(api.runtime.getURL(`dict/${lang}.json`));
    if (!res.ok) throw new Error(`dict/${lang}.json: ${res.status}`);
    return res.json();
  }

  // Translator that always misses. Used for HU lang so the walker restores
  // every node from its remembered original text — i.e. live "untranslate".
  const restoreTranslator = () => null;

  const scheduleIdle =
    typeof requestIdleCallback !== 'undefined'
      ? (cb) => requestIdleCallback(cb, { timeout: 3000 })
      : (cb) => setTimeout(cb, 1000);

  // Once the current view is translated and the page has gone quiet, pull in the
  // remaining zones. A single screen shows text from several of them (a partner
  // modal inside the invoice editor, a subscription banner anywhere), which the
  // route's own shard alone cannot cover. Deferred so it never delays first paint.
  function prefetchAllZones(seq) {
    scheduleIdle(() => {
      if (seq !== applySeq || !loader || !currentTranslate) return;
      loader
        .ensureAll()
        .then((added) => {
          if (!added || seq !== applySeq || !currentTranslate) return;
          currentTranslate.refresh(); // new keys → rebuild the fallback index
          walkAndTranslate(document.body, currentTranslate, currentStats);
        })
        .catch((err) => console.warn('[bt] zone prefetch failed:', err.message));
    });
  }

  async function applyLang(lang) {
    const seq = ++applySeq;
    if (currentObserver) {
      currentObserver.disconnect();
      currentObserver = null;
    }
    currentStats.reset();

    if (lang === 'hu') {
      currentLang = 'hu';
      currentTranslate = null;
      loader = null;
      if (seq !== applySeq) return; // superseded by a newer applyLang call
      walkAndTranslate(document.body, restoreTranslator, currentStats);
      // walkAndTranslate is async (time-sliced) — the observer is idempotent
      // (no-op-by-equality) so it and the deferred walk slices both converge safely.
      currentObserver = installObserver(document.body, restoreTranslator, currentStats);
      return;
    }

    currentLang = lang;
    let translateFn = restoreTranslator;
    try {
      const indexRes = await fetch(api.runtime.getURL('dict/_index.json'));
      if (!indexRes.ok) throw new Error(`_index.json: ${indexRes.status}`);
      const index = await indexRes.json();
      loader = createShardLoader({ index, fetchShard, lang });
      await loader.ensureCommon();
      await loader.ensureZoneForRoute(location.pathname);
      currentTranslate = createTranslator(loader.getMerged());
      translateFn = currentTranslate;
    } catch (err) {
      console.warn('[bt] shard loader unavailable, falling back to monolithic dict:', err.message);
      loader = null;
      const dict = await loadMonolithic(lang);
      currentTranslate = createTranslator(dict);
      translateFn = currentTranslate;
    }

    if (seq !== applySeq) return; // superseded by a newer applyLang call
    walkAndTranslate(document.body, translateFn, currentStats);
    // walkAndTranslate is async (time-sliced) — the observer is idempotent
    // (no-op-by-equality) so it and the deferred walk slices both converge safely.
    currentObserver = installObserver(document.body, translateFn, currentStats);
    prefetchAllZones(seq);
  }

  // Initial load: read storage, apply.
  // Promise-based call works on both Chrome MV3 and Firefox MV3.
  // Also honors a `data-bt-lang` attribute on <html> for automated testing.
  (async () => {
    try {
      const settings = await api.storage.sync.get({ lang: 'hu' });
      const testLang = document.documentElement.getAttribute('data-bt-lang');
      const lang =
        testLang && ['hu', 'en', 'fr'].includes(testLang) ? testLang : settings.lang;
      await applyLang(lang);

      // registered once for the tab's lifetime
      onRouteChange(async (path) => {
        if (currentLang === 'hu' || !loader) return;
        try {
          // load-and-keep: no-op if already loaded. Only rebuild the fallback
          // index when this actually merged new keys — it is a full dict pass.
          const added = await loader.ensureZoneForRoute(path);
          if (added && currentTranslate) currentTranslate.refresh();
        } catch (e) { console.warn('[bt] route zone load failed:', e.message); }
        // Always re-walk the new view, exactly like a language switch does — the
        // walk is idempotent (no-op-by-equality) and time-sliced, so this is cheap
        // and does not depend on the MutationObserver catching the SPA swap.
        walkAndTranslate(document.body, currentTranslate, currentStats);
      });

    } catch (err) {
      console.error('[billingo-translator] init failed:', err);
    }
  })();

  // Listen for messages from popup.
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'setLang') {
      applyLang(msg.lang)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true; // async sendResponse
    }
    if (msg && msg.type === 'getStats') {
      sendResponse({
        ok: true,
        lang: currentLang,
        hits: currentStats.hits,
        misses: currentStats.misses,
        uniqueMisses: [...currentStats.uniqueMisses],
      });
      return false;
    }
    return false;
  });

  // React to lang changes from storage.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.lang) {
      applyLang(changes.lang.newValue).catch((err) => {
        console.error('[billingo-translator] lang change failed:', err);
      });
    }
  });
})();
