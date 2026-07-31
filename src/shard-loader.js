// src/shard-loader.js
// Runtime per-zone shard loader. Resolves a route to a zone via _index.json
// (the P1 contract), lazy-fetches dict/<lang>/<zone>.json, and merges into one
// mutable `merged` object the translator closes over. Load-and-keep (no evict).
// Plain IIFE (no ESM) so it runs as a classical content script.

(function () {
  function createShardLoader({ index, fetchShard, lang }) {
    const merged = {};
    const loaded = new Set();
    const inflight = new Map();

    function zoneForRoute(pathname) {
      for (const { prefix, shard } of index) {
        if (pathname.startsWith(prefix)) return shard;
      }
      return null;
    }

    async function load(shard) {
      if (loaded.has(shard)) return false;
      if (inflight.has(shard)) return inflight.get(shard);
      const p = (async () => {
        try {
          const obj = await fetchShard(lang, shard);
          if (obj && typeof obj === 'object') Object.assign(merged, obj);
          loaded.add(shard);
          return true;
        } catch (e) {
          if (typeof console !== 'undefined') console.warn('[bt] shard load failed:', shard, e && e.message);
          return false;
        } finally {
          inflight.delete(shard);
        }
      })();
      inflight.set(shard, p);
      return p;
    }

    return {
      ensureCommon: () => load('_common'),
      ensureZoneForRoute: (pathname) => {
        const zone = zoneForRoute(pathname);
        return zone ? load(zone) : Promise.resolve(false);
      },
      // Every zone, regardless of route. A single page pulls text from several
      // zones (a partner modal inside the invoice editor, an upsell banner on
      // any screen), so the route's own shard is never the whole story. Called
      // once the page is idle; resolves true when it merged something new.
      ensureAll: () => {
        const zones = new Set(['_common']);
        for (const { shard } of index) zones.add(shard);
        return Promise.all([...zones].map(load)).then((added) => added.some(Boolean));
      },
      getMerged: () => merged,
    };
  }

  globalThis.BillingoTranslator = globalThis.BillingoTranslator || {};
  globalThis.BillingoTranslator.createShardLoader = createShardLoader;
})();
