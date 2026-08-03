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

  // Everything is walked and observed from <html>, not <body>: the browser tab's
  // title is a text node inside <head> (<title>), which a body-rooted walk can
  // never reach — the tab kept showing Hungarian. It is an ordinary text node,
  // so dom-walker needs no special case. Nothing else in <head> is at risk:
  // dom-walker rejects SCRIPT/STYLE/NOSCRIPT text outright and <meta content>
  // is not in its translatable-attribute list. Captured once — documentElement
  // exists by document_idle and never changes for the document's lifetime.
  const walkRoot = document.documentElement;

  // The manifest cannot change while the tab lives, so read the version once.
  // Stamped onto getStats replies so an exported miss list names its build.
  const EXT_VERSION = api.runtime.getManifest().version;

  // Cap on the miss list handed to the popup. A pathological page can produce
  // thousands of unique misses and the reply crosses a process boundary, so an
  // uncapped list would make the message payload unbounded. 2000 strings are
  // already far more than anyone triages by hand.
  const MISS_EXPORT_CAP = 2000;

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
          walkAndTranslate(walkRoot, currentTranslate, currentStats);
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
      walkAndTranslate(walkRoot, restoreTranslator, currentStats);
      // walkAndTranslate is async (time-sliced) — the observer is idempotent
      // (no-op-by-equality) so it and the deferred walk slices both converge safely.
      currentObserver = installObserver(walkRoot, restoreTranslator, currentStats);
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
      // The translator needs the language to compose output the way the curated
      // values do — French puts a space before '! ? ; : »'.
      currentTranslate = createTranslator(loader.getMerged(), { lang });
      translateFn = currentTranslate;
    } catch (err) {
      console.warn('[bt] shard loader unavailable, falling back to monolithic dict:', err.message);
      loader = null;
      const dict = await loadMonolithic(lang);
      currentTranslate = createTranslator(dict, { lang });
      translateFn = currentTranslate;
    }

    if (seq !== applySeq) return; // superseded by a newer applyLang call
    walkAndTranslate(walkRoot, translateFn, currentStats);
    // walkAndTranslate is async (time-sliced) — the observer is idempotent
    // (no-op-by-equality) so it and the deferred walk slices both converge safely.
    currentObserver = installObserver(walkRoot, translateFn, currentStats);
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
        walkAndTranslate(walkRoot, currentTranslate, currentStats);
      });

    } catch (err) {
      console.error('[billingo-translator] init failed:', err);
    }
  })();

  // --- getStats payload ------------------------------------------------------

  // uniqueMisses is a Set at runtime, and Chrome serialises extension messages
  // as JSON — a Set would arrive as `{}`. Always emit an Array (a copy, so the
  // popup never holds a reference to live stats). Tolerates a missing stats
  // object and an already-array uniqueMisses.
  function listMisses(stats) {
    const misses = stats && stats.uniqueMisses;
    if (!misses) return [];
    return Array.isArray(misses) ? misses.slice() : [...misses];
  }

  // A counter that got clobbered must not surface as NaN/undefined in the popup.
  const toCount = (n) => (Number.isFinite(n) ? n : 0);

  // Shape the reply to a `getStats` message. Pure — every input is passed in —
  // so it is unit-testable without chrome.* or fetch; that is why it is
  // published on BillingoTranslator at the bottom of this file.
  //
  // Backward compatible by contract: `ok`, `lang`, `hits`, `misses` and
  // `uniqueMisses` keep the names and the meaning they had before an export UI
  // existed. `pathname`, `version`, `uniqueMissCount` and `truncated` are
  // additive, and make a harvested list self-describing: which page produced it,
  // which build, and whether it is the whole story.
  function buildStatsPayload({ lang, stats, pathname, version, cap = MISS_EXPORT_CAP }) {
    const all = listMisses(stats);
    // A garbage cap would silently empty the list (slice(0, NaN) === []), which
    // reads as "no misses" instead of an error. Fall back to the real cap.
    const limit = Number.isFinite(cap) && cap >= 0 ? cap : MISS_EXPORT_CAP;
    return {
      ok: true,
      lang,
      hits: toCount(stats && stats.hits),
      misses: toCount(stats && stats.misses),
      uniqueMisses: all.slice(0, limit),
      uniqueMissCount: all.length, // total before the cap, so "2000 of N" is sayable
      truncated: all.length > limit,
      pathname,
      version,
    };
  }

  // Listen for messages from popup.
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'setLang') {
      applyLang(msg.lang)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true; // async sendResponse
    }
    if (msg && msg.type === 'getStats') {
      // location is read per message, not cached: the SPA navigates under us.
      sendResponse(buildStatsPayload({
        lang: currentLang,
        stats: currentStats,
        pathname: location.pathname,
        version: EXT_VERSION,
      }));
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

  // Published for the unit tests (tests/content-stats.test.js): the rest of this
  // file needs chrome.* and fetch, buildStatsPayload needs nothing.
  // Self-initialise the namespace like every other src/ file, so publishing does not
  // depend on load order (the destructure at the top would already have thrown, but
  // the pattern should be uniform across the five scripts).
  globalThis.BillingoTranslator = globalThis.BillingoTranslator || {};
  globalThis.BillingoTranslator.buildStatsPayload = buildStatsPayload;
})();
