// src/translator.js
// Pure logic: dictionary lookup + stats tracking. No DOM, no chrome APIs.
// Loaded as a plain (non-module) content script in the extension. Source uses
// no ESM exports so Chrome's classical script context accepts it. Tests use
// the vm module (see tests/load-script.js) to evaluate this file in a sandbox
// and read the BillingoTranslator binding.
//
// Lookup runs in layers, most reliable first and most destructive last. The
// numbers below are stable layer identities, listed in execution order — which is
// why 5 appears before 4. Everything past layer 1 exists because Billingo renders
// text the dictionary cannot hold verbatim:
//   1. exact          dict['Számlák']
//   2. whitespace     the DOM indents and wraps; NBSP is used in prices
//   3. punctuation    the same label ships as 'Adószám', 'Adószám:', 'Figyelem'
//                     and 'Figyelem!'
//   5. case variant   the app renders both 'Bezárás' and 'bezárás', and shouts
//                     'TÖRLÉS' where the dictionary holds 'Törlés'
//   4. patterns       ':type letöltése' is never rendered — ':type' is substituted
//                     first, and '3 db' should also cover '7 db'
//   7. parenthetical  'Cím (opcionális)' from 'Cím' + 'opcionális'
//   8. separator      'Kelt / Fizetve' from 'Kelt' + 'Fizetve' (table headers are
//                     composed combinatorially, so the capture saw only a few)
// Layer 5 runs before layer 4 because it only ever returns a human-authored
// entry for that exact string, and a real entry must beat a generalised regex.
// Layers 7 and 8 run *after* layer 4 because the dictionary holds patterns whose
// literal text contains parentheses and separators ('… (Sor: :line)'); letting
// them decompose first would emit '(Sor: 3)' where layer 4 emits '(Line: 3)'.
// Layer 8 is last: it is the only layer that rewrites the interior of a string.
//
// Layers 2 and 4 need an index over the dictionary; it is built lazily on the
// first miss and invalidated by refresh() when the shard loader merges a new
// zone. Layers 1, 3, 5, 7 and 8 read the dictionary live (all of them go through
// lookupPlain), so a merged zone works for them immediately.
//
// Two rules every layer must respect:
//   - an empty dictionary value is a MISS, never blank output. Only lookupPlain
//     may touch `dict`, and it enforces this, so no layer can blank a label.
//   - the derived layers (5, 7, 8) return null rather than their own input. They
//     synthesise a string, so they can echo the Hungarian without translating it
//     ('Standard / Basic'), and the walker records a hit for any non-null return —
//     an echo would inflate the popup's coverage percentage for free. Layers 1-4
//     are exempt: they return a human-authored value, and a translation that
//     legitimately equals its key is a real hit.
//
// createTranslator(dict, { lang }) takes the active language because the layers
// that *compose* output have to respect the target language's typography — a
// generated 'Attention!' next to the curated 'Erreur !' reads as a bug. An
// absent or unrecognised lang keeps the composition byte-for-byte identical to
// what it was before the option existed.

(function () {
  // JS \s already covers NBSP ( ) and narrow NBSP ( ).
  const WS_RUN = /\s+/g;
  // Sentence punctuation is included because toasts, validation errors and
  // confirm dialogs ship as 'Figyelem!' / 'Hiba!' / 'Hogyan működik?' while the
  // same label also ships bare. '…' is a single character, so it is ASCII '.'
  // that covers 'Folyamatban...'. Layer 3 requires a letter in the surviving
  // core, which is what keeps '1.' and '27%.' out.
  const TRAILING_PUNCT = /[\s:*·•…?!.,;»]+$/;
  const DIGIT_RUN = /\d+/g;
  // Exactly what can sit between the digit groups of ONE grouped number: a space
  // (plain, NBSP or narrow NBSP), a dot or a comma. Same character set as
  // NUMBER_CAPTURE, so the two agree on what counts as a single amount.
  const GROUP_SEPARATOR_ONLY = /^[.,   ]+$/;
  const LETTER = /\p{L}/u;
  const LETTERS = /\p{L}/gu;
  const UPPER = /\p{Lu}/u;
  const LOWER = /\p{Ll}/u;
  // Hungarian has locale-specific casing rules, so never rely on the ambient one.
  const CASE_LOCALE = 'hu-HU';
  // Capturing, so split() restores the whitespace verbatim.
  const WS_SPLIT = /(\s+)/;
  const TRAILING_WS = /\s$/;

  // 'fr', 'fr-FR', 'fr_FR'. Anything else — including undefined — is treated as
  // "no typography rules to apply".
  const FRENCH_LANG = /^fr(?:[-_]|$)/i;
  // French sets a space before these four marks and before ':'. Measured on the
  // curated dict/fr.json values: label-final '!' is 188 spaced / 9 unspaced, ':'
  // 78 / 4, '?' 48 / 8, '»' 6 / 0 — and the space is U+0020 in every case but
  // two ('?' with U+00A0), so U+0020 is the shipped convention to match.
  // '«' would take a space *after* it, but no layer ever composes across one.
  const FR_SPACED_PUNCT = /^[!?;:»]/;
  const FR_SPACE = ' ';

  // Shapes whose leading capital is load-bearing: lowercasing the first letter
  // corrupts the token instead of restyling the sentence. Only the lowercasing
  // direction of layer 5 consults these — upper-casing a lowercase word is
  // always safe.
  const KEEP_FIRST_CASE = [
    // 'VAT rate', 'API key' → 'vAT rate'
    /^\p{Lu}\p{Lu}/u,
    // 'Q1' / 'T1' from 'I. negyedév' → 'q1'; a quarter label, not a sentence
    /^\p{Lu}\p{Nd}/u,
    // "Meska.hu is Hungary's …" → 'meska.hu …'; a domain, not a sentence start
    /^\p{Lu}[\p{L}\p{Nd}_-]*\.\p{L}/u,
    // 'PayPal', 'BillingoBox' — an inner capital marks a brand, not a word
    /^\p{Lu}[\p{Ll}\p{Nd}]*\p{Lu}/u,
  ];

  // A token whose case carries information, so the ALL-CAPS branch of layer 5
  // must leave it alone. Deliberately narrow — a token is only spared when it
  // carries positive evidence of being machine-readable, because everything else
  // in a shouted label is prose that must shout too:
  //   @\p{L}        'hello@billingo.hu' — an address
  //   :\p{L}        ':type', 'text-decoration:underline' — a placeholder, CSS
  //   _             'SZAMLAZO_XML', 'api_key' — an identifier or form name
  //   ://           a URL, whose path is case-sensitive
  //   ab.cd         'billingo.hu' — a domain. Two letters each side, so the
  //                 abbreviations 'pl.', 'e.g.' stay prose and still shout.
  //   < or =        markup residue, where a CSS class or href would break
  const CASED_TOKEN = /@\p{L}|:\p{L}|_|:\/\/|\p{L}{2,}\.\p{L}{2,}|[<=]/u;

  // 'Head (tail)' — the whitespace before '(' is load-bearing. Every glued
  // 'Head(tail)' string in the dictionary is Hungarian morphology rather than a
  // parenthetical ('a(z)', 'E-mail cím(ek)', 'vagy hónap(ok)'), and decomposing
  // those yields 'Email address (ek)'. '[^()]*' refuses nested parentheses.
  const PAREN_TAIL = /^(.*\S)\s+\(([^()]*)\)$/;
  // Spaces on both sides are mandatory: 273 keys carry a bare '/' ('Swift/BIC
  // kód', 'Ft/hó', 'Visa/Mastercard', every URL) and splitting those shreds them.
  const SEPARATOR = /( - | – | — | \| | \/ | · | > )/;
  // A long string containing an incidental dash or parenthesis is Hungarian
  // prose, not a composed label, and decomposing it cannot end well.
  const COMPOSITE_MAX_LEN = 80;
  const MAX_SEGMENTS = 4;

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
  // NFC is folded in here, on purpose: normalizeWs is the fallback path's helper
  // and never runs before the exact layer has already missed, so the hot path
  // pays nothing. Exactly 2 of the app's ~10 400 strings ('Bejegyzés kelte',
  // 'Bejegyzés dátuma') render with combining accents while 0 dictionary keys
  // do, so those two could never match by byte equality.
  const normalizeWs = (s) => s.replace(WS_RUN, ' ').trim().normalize('NFC');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const countLetters = (s) => (s.match(LETTERS) || []).length;
  // 'TÖRLÉS' yes, 'Törlés' no, '27%' no ('A' alone is a word, not a shout).
  const isAllCaps = (s) => UPPER.test(s) && !LOWER.test(s) && countLetters(s) >= 2;
  const upperFirst = (s) => s.charAt(0).toLocaleUpperCase(CASE_LOCALE) + s.slice(1);
  const lowerFirst = (s) => s.charAt(0).toLocaleLowerCase(CASE_LOCALE) + s.slice(1);

  // Restore the source's leading case onto a translation found in the other case.
  const recaseFirst = (hit, wantUpper) => {
    if (wantUpper) return upperFirst(hit);
    // 'áfa' flips to 'Áfa' → 'VAT', and 'i. negyedév' to 'I. negyedév' → 'Q1':
    // neither 'vAT' nor 'q1' is an improvement on leaving the case alone.
    if (KEEP_FIRST_CASE.some((re) => re.test(hit))) return hit;
    return lowerFirst(hit);
  };

  // Shout a translation token by token, so the tokens whose case means something
  // survive. Uppercasing the whole string is what turned 'hello@billingo.hu' into
  // 'HELLO@BILLINGO.HU'.
  const shout = (s) =>
    s
      .split(WS_SPLIT)
      .map((part) => (CASED_TOKEN.test(part) ? part : part.toLocaleUpperCase(CASE_LOCALE)))
      .join('');

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

    // A grouped amount is ONE number, not several. '15 000 Ft' has two digit runs
    // separated by nothing but a thousands separator, so generalising each run
    // independently builds a catch-all over every Hungarian-formatted amount, and
    // render() then re-joins the captures with the SEPARATOR THE VALUE USED:
    // '1 234 567 Ft' came out as '1 234,567 HUF' because the value was '15,000 HUF'.
    // A mangled invoice total is worse than untranslated text, so refuse the pattern
    // when two consecutive slots are separated only by a group separator.
    for (let i = 1; i < slots.length; i++) {
      if (GROUP_SEPARATOR_ONLY.test(key.slice(slots[i - 1].end, slots[i].start))) return null;
    }

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

  function createTranslator(dict, options) {
    let index = null;
    const ensureIndex = () => (index || (index = buildIndex(dict)));
    // Config, not state: it never changes for a given translator, so refresh()
    // has nothing to invalidate here.
    const isFrench = FRENCH_LANG.test((options && options.lang) || '');

    // Put back the punctuation run layer 3 stripped. French wants a space before
    // '! ? ; : »' — this is the only place a layer emits a mark of its own next
    // to a translation, so it is the only place the rule has to be applied.
    function appendTrailing(hit, run) {
      if (!isFrench || !FR_SPACED_PUNCT.test(run)) return hit + run;
      // The app already spaced it, or the value ends in a space: adding another
      // would double it.
      if (TRAILING_WS.test(hit)) return hit + run;
      return hit + FR_SPACE + run;
    }

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

    // Layers 1-3. Neither recases nor decomposes, so it is the recursion floor
    // every composite layer resolves its fragments through.
    function lookupDirect(text) {
      const plain = lookupPlain(text);
      if (plain !== null) return plain;

      // Layer 3: the same label ships with and without a trailing colon, a
      // required-field marker or sentence punctuation. Put the exact original
      // run back so the UI keeps its shape.
      const core = text.replace(TRAILING_PUNCT, '');
      if (core === text || !LETTER.test(core)) return null;
      const hit = lookupPlain(core);
      return hit === null ? null : appendTrailing(hit, text.slice(core.length));
    }

    // Layer 5: the dictionary holds 103 pairs that differ only in leading case
    // and 40 ALL-CAPS keys, i.e. the app demonstrably renders the same string in
    // several cases and the capture only saw some of them. Re-enters layers 1-3
    // on the recased string only, never the layers below, so it cannot recurse.
    function lookupCaseVariant(text) {
      if (isAllCaps(text)) {
        const lower = text.toLocaleLowerCase(CASE_LOCALE);
        const sentence = upperFirst(lower);
        // Sentence case first: a shouting button is authored 'Törlés' far more
        // often than 'törlés'. When the first character is uncased ('5 DB' →
        // '5 db') the two forms are identical, so only try one of them.
        const forms = sentence === lower ? [lower] : [sentence, lower];
        for (const form of forms) {
          if (form === text) continue;
          const hit = lookupDirect(form);
          if (hit === null) continue;
          const out = shout(hit);
          return out === text ? null : out;
        }
        return null;
      }

      const first = text.charAt(0);
      const upper = first.toLocaleUpperCase(CASE_LOCALE);
      const lower = first.toLocaleLowerCase(CASE_LOCALE);
      // An uncased first character ('3 db', '12 345 Ft') has no variant to try.
      if (upper === lower) return null;
      const wasUpper = first === upper;
      const hit = lookupDirect((wasUpper ? lower : upper) + text.slice(1));
      if (hit === null) return null;
      const out = recaseFirst(hit, wasUpper);
      return out === text ? null : out;
    }

    // Layers 1-3 + 5: the whole non-decomposing path. The composite layers below
    // are its only other callers, which is what bounds recursion — 'A / B (C / D)'
    // cannot re-enter the splitting layers.
    function lookupSimple(text) {
      return lookupDirect(text) ?? lookupCaseVariant(text);
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

    // Layer 7: form hints and list filters are composed at render time —
    // 'Cím (opcionális)', 'Mind (0)' — so the capture only ever saw the
    // combinations it happened to walk past.
    //
    // All or nothing over the lettered parts, exactly like layer 8. This layer
    // decomposes arbitrary strings, and the walker does not know UI chrome from
    // user data: a product literally named 'Termék (Nagy)' or 'Javítás (Autó)'
    // reaches it too. Accepting an unresolved tail meant one unknown word (a
    // surname, a model number) was enough to get the *other* half rewritten,
    // which is the shape of an invoice line the user might proof-read while the
    // issued PDF and the NAV payload still carry the Hungarian. A part with no
    // letter ('Mind (0)', '(2026-01-01)') carries no lexeme, so it passes through
    // untouched and does not block the layer.
    function lookupParenTail(text) {
      if (text.length > COMPOSITE_MAX_LEN) return null;
      const m = PAREN_TAIL.exec(text);
      if (!m) return null;

      const head = lookupSimple(m[1]);
      if (head === null) return null;
      const tail = LETTER.test(m[2]) ? lookupSimple(m[2]) : m[2];
      if (tail === null) return null;
      const out = `${head} (${tail})`;
      // 'ÁTHK (ÁFA területén hatályon kívüli)' translates to itself; the walker
      // counts any non-null return as a hit, so hand it back as a clean miss.
      return out === text ? null : out;
    }

    // Layer 8, last because it is the only layer that rewrites the interior of a
    // string: sortable table headers and settings breadcrumbs are composed
    // combinatorially ('Kelt / Fizetve', 'Beállítások / Integrációk'). All or
    // nothing — a partially resolved split emits mixed-language output, which
    // measures far worse than leaving the string alone.
    function lookupSeparated(text) {
      if (text.length > COMPOSITE_MAX_LEN) return null;
      // Capturing group: separators survive at the odd indices and are restored
      // verbatim, so the split never invents or drops a character.
      const parts = text.split(SEPARATOR);
      if (parts.length < 3 || parts.length > MAX_SEGMENTS * 2 - 1) return null;

      const out = parts.slice();
      let lettered = 0;
      let resolved = 0;
      for (let i = 0; i < parts.length; i += 2) {
        // A part with no letter ('2026-01-01 - 2026-02-01', '1 - 3') carries no
        // lexeme: keep it verbatim and do not let it vote on the outcome.
        if (!LETTER.test(parts[i])) continue;
        lettered += 1;
        const hit = lookupSimple(parts[i]);
        if (hit === null) continue;
        resolved += 1;
        out[i] = hit;
      }
      if (lettered === 0 || resolved !== lettered) return null;

      const joined = out.join('');
      return joined === text ? null : joined;
    }

    function translate(text) {
      if (typeof text !== 'string') return null;
      const trimmed = text.trim();
      if (trimmed === '') return null;

      // Layers 1-3 and 5.
      const simple = lookupSimple(trimmed);
      if (simple !== null) return simple;

      // Layer 4 before the composite layers: the dictionary holds patterns whose
      // literal text contains a parenthesis ('… lehet. (Sor: :line)'), and a
      // generalised pattern that knows the whole sentence beats decomposition.
      const pattern = lookupPattern(trimmed);
      if (pattern !== null) return pattern;

      // Layers 7-8 rebuild a string, so they work on the normalised form: the
      // DOM's own indentation is not worth preserving in composed output.
      const norm = normalizeWs(trimmed);
      return lookupParenTail(norm) ?? lookupSeparated(norm);
    }

    // The shard loader merges new zones into the same `dict` object. Layers 1, 3,
    // 5, 7 and 8 see them at once (they all read through lookupPlain); the
    // derived index behind layers 2 and 4 must be rebuilt explicitly.
    translate.refresh = () => { index = null; };
    return translate;
  }

  // Remembering our own output is what keeps the harvested miss list usable, but it
  // must not grow without bound on a long-lived tab. Past the cap we stop learning
  // new output: the strings that matter are the ones already seen.
  // Above the merged size of every zone (~9.6 k entries), because content.js keeps
  // ONE stats object for the tab's whole life and only resets it on a language
  // change, while prefetchAllZones eagerly merges every zone. A cap below that is
  // reachable in a long single-tab session, and past it the tooltip pollution
  // quietly returns for the strings that no longer fit.
  const EMITTED_CAP = 12000;

  // --- what counts as a miss ------------------------------------------------

  // Everything the translator could not render used to be recorded as a miss, which meant
  // amounts, UUIDs, dates and lone punctuation. On one real inventory page that was 169 of
  // 310 exported strings: the export is the only feedback loop from usage back into the
  // dictionary, and the signal was 3 % of the file. It also depressed the coverage
  // percentage the popup shows, since `misses` feeds it.
  //
  // The test is deliberately structural, never semantic. Strip digits, separators,
  // currency symbols and currency codes; if no run of two or more letters survives, the
  // string cannot be a word in any language, so it is not something we failed to
  // translate. A person's or company's name is NOT filtered: `Példa Péter` and
  // `Szállító adatok` are both two Hungarian-looking words, and a rule that dropped one
  // would drop real UI text with it. Guessing wrong there hides strings we need; leaving a
  // name in the export costs the reader a glance.
  const CURRENCY_CODE = /\b(?:Ft|HUF|EUR|USD|GBP|CHF|RON|PLN|CZK)\b/gi;
  const NON_WORD_CHARS = /[\d\s.,;:!?=+\-*/\\|()[\]{}<>«»"'’…%×€$£¥&#@~^°]/g;
  const TWO_LETTER_RUN = /\p{L}{2,}/u;
  // A string the UI itself cut short is never a dictionary key: the dictionary holds the
  // whole value, so the fragment can only ever miss.
  const VISUALLY_TRUNCATED = /^(?:\.{3}|…)|(?:\.{3}|…)$/;
  const EMAIL_OR_URL = /^(?:\S+@\S+\.\S+|(?:https?:\/\/|www\.)\S+)$/i;

  function isReportableMiss(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (trimmed === '') return false;
    if (VISUALLY_TRUNCATED.test(trimmed)) return false;
    if (EMAIL_OR_URL.test(trimmed)) return false;
    // A label that IS one letter ('x' on a close button) is real text and is kept. A lone
    // letter inside something else ('D02 T380', an Eircode) is not. Measured against a
    // real 310-string export, that distinction is the only thing the two-letter rule
    // would otherwise have discarded, and it was the postcode.
    if (trimmed.length === 1) return LETTER.test(trimmed);
    const words = trimmed.replace(CURRENCY_CODE, ' ').replace(NON_WORD_CHARS, ' ');
    return TWO_LETTER_RUN.test(words);
  }

  function createStats() {
    const emitted = new Set(); // translations we produced, verbatim
    const stats = {
      hits: 0,
      misses: 0,
      uniqueMisses: new Set(),
      // `output`, when given, is the translation just written. Bootstrap renders
      // .tooltip-inner from the stashed (already translated) title, so our own
      // output comes back at us as a brand-new text node.
      recordHit(_text, output) {
        stats.hits += 1;
        if (typeof output === 'string' && output !== '' && emitted.size < EMITTED_CAP) {
          emitted.add(output);
        }
      },
      recordMiss(text) {
        // Our own output re-entering the DOM is neither a hit nor a miss. Counting
        // it as a miss both depressed the popup's coverage percentage and put
        // English/French strings into the exported "untranslated Hungarian" list,
        // which made that export useless for dictionary work.
        if (emitted.has(text)) return;
        // Amounts, identifiers and punctuation are not untranslated text, and counting
        // them made both the export and the coverage percentage wrong.
        if (!isReportableMiss(text)) return;
        stats.misses += 1;
        stats.uniqueMisses.add(text);
      },
      reset() {
        stats.hits = 0;
        stats.misses = 0;
        stats.uniqueMisses.clear();
        emitted.clear();
      },
    };
    return stats;
  }

  globalThis.BillingoTranslator = globalThis.BillingoTranslator || {};
  globalThis.BillingoTranslator.createTranslator = createTranslator;
  globalThis.BillingoTranslator.createStats = createStats;
  // Exposed for the tests: the rule decides both what the popup exports and what the
  // coverage percentage is computed from, so it needs assertions of its own.
  globalThis.BillingoTranslator.isReportableMiss = isReportableMiss;
})();
