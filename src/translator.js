// src/translator.js
// Pure logic: dictionary lookup + stats tracking. No DOM, no chrome APIs.
// Loaded as a plain (non-module) content script in the extension. Source uses
// no ESM exports so Chrome's classical script context accepts it. Tests use
// the vm module (see tests/load-script.js) to evaluate this file in a sandbox
// and read the BillingoTranslator binding.
//
// Lookup runs in layers, cheapest first. Everything past layer 1 exists because
// Billingo renders text the dictionary cannot hold verbatim:
//   1. exact          dict['Számlák']
//   2. whitespace     the DOM indents and wraps; NBSP is used in prices
//   3. punctuation    the same label ships as 'Adószám' and 'Adószám:'
//   4. patterns       ':type letöltése' is never rendered — ':type' is substituted
//                     first, and '3 db' should also cover '7 db'
// Layers 2-4 need an index over the dictionary; it is built lazily on the first
// miss and invalidated by refresh() when the shard loader merges a new zone.
// Layers 1 and 3 read the dictionary live, so a merged zone works immediately.

(function () {
  // JS \s already covers NBSP ( ) and narrow NBSP ( ).
  const WS_RUN = /\s+/g;
  const TRAILING_PUNCT = /[\s:*·•…]+$/;
  const DIGIT_RUN = /\d+/g;
  const LETTER = /\p{L}/u;
  const LETTERS = /\p{L}/gu;

  // A Laravel-style placeholder: ':name', not preceded by a word char or another
  // colon. Rules out '10:00', 'https://…' and 'text-decoration:underline'.
  const newTokenRe = () => /(?<![\w:]):([a-zA-Z_][a-zA-Z0-9_]*)/g;

  // A rendered number may carry thousands separators ('1 234', '1.234').
  const NUMBER_CAPTURE = '(\\d[\\d.,\\u00A0\\u202F ]*\\d|\\d)';
  const TEXT_CAPTURE = '([\\s\\S]+?)';
  // Below this, a pattern's literal part is too thin to identify anything and it
  // would match unrelated text (':type' alone matches every string).
  const MIN_PATTERN_LETTERS = 2;

  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const normalizeWs = (s) => s.replace(WS_RUN, ' ').trim();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const countLetters = (s) => (s.match(LETTERS) || []).length;

  // --- pattern compilation ---------------------------------------------------

  // Turn a key into a matcher by replacing its `slots` (sorted, non-overlapping
  // [start,end) ranges) with capture groups. Returns null when the surviving
  // literal text is too thin to be identifying.
  function compileMatcher(key, slots, capture) {
    let source = '^';
    let literals = '';
    let probe = '';
    let cursor = 0;
    for (const slot of slots) {
      const literal = key.slice(cursor, slot.start);
      source += escapeRe(literal) + capture;
      literals += literal;
      if (literal.length > probe.length) probe = literal;
      cursor = slot.end;
    }
    const tail = key.slice(cursor);
    source += escapeRe(tail) + '$';
    literals += tail;
    if (tail.length > probe.length) probe = tail;

    const letters = countLetters(literals);
    if (letters < MIN_PATTERN_LETTERS) return null;
    return { re: new RegExp(source), probe: probe.trim(), weight: letters };
  }

  function findTokens(s) {
    const re = newTokenRe();
    const out = [];
    let m;
    while ((m = re.exec(s))) out.push({ name: m[1], start: m.index, end: m.index + m[0].length });
    return out;
  }

  // ':type letöltése' / 'Télécharger :type' — captures fill the tokens by name.
  function compileNamedPattern(key, value) {
    const keyTokens = findTokens(key);
    if (keyTokens.length === 0) return null;
    // A translation that kept no token cannot be rebuilt from the captures.
    const valueTokens = findTokens(value);
    if (valueTokens.length === 0) return null;
    const known = new Set(keyTokens.map((t) => t.name));
    if (!valueTokens.every((t) => known.has(t.name))) return null;

    const matcher = compileMatcher(key, keyTokens, TEXT_CAPTURE);
    if (!matcher) return null;
    return {
      re: matcher.re,
      probe: matcher.probe,
      weight: matcher.weight,
      render(groups, translateFragment) {
        const byName = Object.create(null);
        keyTokens.forEach((t, i) => {
          if (!(t.name in byName)) byName[t.name] = translateFragment(groups[i]);
        });
        return value.replace(newTokenRe(), (whole, name) =>
          (name in byName ? byName[name] : whole));
      },
    };
  }

  // '3 db' / '3 pcs' — generalised to any number. Only safe when both sides carry
  // the same digit runs in the same order, so capture i maps to occurrence i.
  // Caveat: the target-language plural is whatever the source pair used, hence
  // the plural-preferring tie-break in buildIndex.
  function compileNumericPattern(key, value) {
    const keyDigits = key.match(DIGIT_RUN);
    const valueDigits = value.match(DIGIT_RUN);
    if (!keyDigits || !valueDigits) return null;
    if (keyDigits.length !== valueDigits.length) return null;
    if (keyDigits.some((d, i) => d !== valueDigits[i])) return null;

    const slots = [];
    DIGIT_RUN.lastIndex = 0;
    let m;
    while ((m = DIGIT_RUN.exec(key))) slots.push({ start: m.index, end: m.index + m[0].length });

    const matcher = compileMatcher(key, slots, NUMBER_CAPTURE);
    if (!matcher) return null;
    const parts = value.split(DIGIT_RUN);
    return {
      re: matcher.re,
      probe: matcher.probe,
      weight: matcher.weight,
      first: Number(keyDigits[0]),
      render(groups) {
        let out = parts[0];
        for (let i = 1; i < parts.length; i++) out += (groups[i - 1] ?? '') + parts[i];
        return out;
      },
    };
  }

  // One pass over the dictionary: normalised keys + every usable pattern.
  function buildIndex(dict) {
    const normalized = Object.create(null);
    const patterns = [];
    const numericBySource = new Map(); // dedupe same-shape numeric patterns

    for (const key in dict) {
      if (!hasOwn(dict, key)) continue;
      const value = dict[key];
      if (typeof value !== 'string' || value === '') continue;

      const norm = normalizeWs(key);
      if (!(norm in normalized)) normalized[norm] = value;

      const named = compileNamedPattern(norm, value);
      if (named) { patterns.push(named); continue; }

      const numeric = compileNumericPattern(norm, value);
      if (!numeric) continue;
      // Same shape from several keys ('1 nap', '5 nap'): keep the pair with the
      // largest number, whose translation is already in the plural form.
      const seen = numericBySource.get(numeric.re.source);
      if (!seen || numeric.first > seen.first) numericBySource.set(numeric.re.source, numeric);
    }
    for (const numeric of numericBySource.values()) patterns.push(numeric);

    // Most literal text first: the most specific pattern must win.
    patterns.sort((a, b) => b.weight - a.weight);
    return { normalized, patterns };
  }

  // --- lookup ----------------------------------------------------------------

  function createTranslator(dict) {
    let index = null;
    const ensureIndex = () => (index || (index = buildIndex(dict)));

    // Layers 1-2. Kept separate because pattern captures reuse it to translate
    // the fragment they captured, and must not recurse into the pattern layer.
    function lookupPlain(text) {
      if (hasOwn(dict, text)) {
        const hit = dict[text];
        if (typeof hit === 'string' && hit !== '') return hit;
      }
      const norm = normalizeWs(text);
      const byNorm = ensureIndex().normalized;
      if (norm !== text && hasOwn(byNorm, norm)) return byNorm[norm];
      return null;
    }

    function lookupPattern(text) {
      const norm = normalizeWs(text);
      for (const pattern of ensureIndex().patterns) {
        if (pattern.probe && norm.indexOf(pattern.probe) === -1) continue;
        const m = pattern.re.exec(norm);
        if (!m) continue;
        const groups = m.slice(1);
        return pattern.render(groups, (fragment) => lookupPlain(fragment.trim()) ?? fragment);
      }
      return null;
    }

    function translate(text) {
      if (typeof text !== 'string') return null;
      const trimmed = text.trim();
      if (trimmed === '') return null;

      const plain = lookupPlain(trimmed);
      if (plain !== null) return plain;

      // Layer 3: the same label ships with and without a trailing colon or a
      // required-field marker. Put the punctuation back so the UI keeps its shape.
      const core = trimmed.replace(TRAILING_PUNCT, '');
      if (core !== trimmed && LETTER.test(core)) {
        const hit = lookupPlain(core);
        if (hit !== null) return hit + trimmed.slice(core.length);
      }

      return lookupPattern(trimmed);
    }

    // The shard loader merges new zones into the same `dict` object. Layers 1
    // and 3 see them at once; the derived index must be rebuilt explicitly.
    translate.refresh = () => { index = null; };
    return translate;
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
