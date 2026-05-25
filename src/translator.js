// src/translator.js
// Pure logic: dictionary lookup + stats tracking. No DOM, no chrome APIs.
// Loaded as a plain (non-module) content script in the extension. Source uses
// no ESM exports so Chrome's classical script context accepts it. Tests use
// the vm module (see tests/load-script.js) to evaluate this file in a sandbox
// and read the BillingoTranslator binding.

(function () {
  function createTranslator(dict) {
    return function translate(text) {
      if (typeof text !== 'string') return null;
      const trimmed = text.trim();
      if (trimmed === '') return null;
      const hit = dict[trimmed];
      // Treat an empty translation as a miss: a not-yet-translated key (value '')
      // must leave the original Hungarian text in place, never blank it out.
      return (hit === undefined || hit === '') ? null : hit;
    };
  }

  function createStats() {
    const stats = {
      hits: 0,
      misses: 0,
      uniqueMisses: new Set(),
      recordHit(_text) {
        stats.hits += 1;
      },
      recordMiss(text) {
        stats.misses += 1;
        stats.uniqueMisses.add(text);
      },
      reset() {
        stats.hits = 0;
        stats.misses = 0;
        stats.uniqueMisses.clear();
      },
    };
    return stats;
  }

  globalThis.BillingoTranslator = globalThis.BillingoTranslator || {};
  globalThis.BillingoTranslator.createTranslator = createTranslator;
  globalThis.BillingoTranslator.createStats = createStats;
})();
