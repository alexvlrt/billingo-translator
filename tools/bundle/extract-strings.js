// tools/bundle/extract-strings.js
// Pure: extract candidate Hungarian UI strings from a JS chunk's source text.
// acorn walks string + template literals (correct unescaping). A literal is kept
// when it is Hungarian (isLikelyHu) OR is the value of a known UI-text property
// (label/text/title/...) — the latter rescues accent-less HU labels — and is not
// noise. Literals containing inline HTML also emit their tag-stripped text
// fragments, so the DOM text nodes the runtime walker sees get keys too.
//
// Two extra sources are harvested because Billingo's i18n message catalogs hold
// the richest UI text (incl. accent-less strings indistinguishable from
// CSS/config by accent alone):
//   1. JSON-string catalog blobs — the whole catalog is embedded as ONE string
//      literal (`'{"Label:api_key":"API kulcs",...}'`); it is JSON.parsed and its
//      values harvested.
//   2. HU-dense object literals — an object whose string values are mostly
//      Hungarian is treated as a message catalog, so ALL its values are kept
//      (including accent-less ones like "API kulcs"). CSS/config objects, being
//      not HU-dense, are left alone.
//
// Returns { strings, catalog }. `catalog` is the subset coming from those two
// i18n-catalog sources: that catalog is loaded app-wide at runtime, so the caller
// routes it to `_common` (a chunk-local zone would hide it on every other page).
// `strings` minus `catalog` are route-local inline strings, safe to shard by zone.
import { Parser } from 'acorn';

const UI_TEXT_KEYS = new Set([
  'label', 'text', 'title', 'message', 'placeholder', 'tooltip', 'header',
  'description', 'subtitle', 'confirmText', 'cancelText', 'okText', 'content',
  'hint', 'help', 'caption', 'heading', 'subheading',
]);

// Fraction of an object's contentful string values that must look Hungarian for
// it to count as a message catalog (then accent-less values are kept too).
const CATALOG_DENSITY = 0.25;
const CATALOG_MIN_VALUES = 3;

function tryParse(source) {
  for (const sourceType of ['script', 'module']) {
    try { return Parser.parse(source, { ecmaVersion: 'latest', sourceType }); }
    catch { /* try next */ }
  }
  return null;
}

function stripHtmlFragments(s) {
  if (!/<[a-z!/][^>]*>/i.test(s)) return [];
  return s.split(/<[^>]+>/).map((t) => t.trim()).filter(Boolean);
}

// Recursively collect every string value from a parsed JSON object/array.
function collectStringValues(v, bag) {
  if (typeof v === 'string') bag.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStringValues(x, bag);
  else if (v && typeof v === 'object') for (const k in v) collectStringValues(v[k], bag);
}

export function extractStrings(source, { isLikelyHu, looksLikeNoise }) {
  const out = new Set();
  const catalog = new Set();
  const ast = tryParse(source);
  if (!ast) return { strings: out, catalog };

  const consider = (raw, forceKeep, fromCatalog) => {
    if (typeof raw !== 'string') return;
    const s = raw.trim();
    if (!s || looksLikeNoise(s)) return;
    const hu = isLikelyHu(s);
    if (!(forceKeep || hu)) return;
    // An accent-less value force-kept from a catalog must still LOOK like UI text,
    // not a bare code token (button/primary/name/id/alert...). Require a space, an
    // uppercase/accented start, or real length.
    if (forceKeep && !hu && !/\s/.test(s) && !/^[A-ZÁÉÍÓÖŐÚÜŰ]/.test(s) && s.length < 12) return;
    out.add(s);
    if (fromCatalog) catalog.add(s);
    // Fragments from an HTML-bearing string inherit keep status so that
    // accent-less link-text nodes ("Pro csomagot") are also emitted.
    const fragForce = forceKeep || hu;
    for (const frag of stripHtmlFragments(s)) {
      if (!looksLikeNoise(frag) && (isLikelyHu(frag) || fragForce)) {
        out.add(frag);
        if (fromCatalog) catalog.add(frag);
      }
    }
  };

  // Is a bag of string values dense enough in Hungarian to be a message catalog?
  const isCatalog = (values) => {
    const contentful = values.filter((v) => typeof v === 'string'
      && v.trim().length >= 2 && !looksLikeNoise(v.trim()));
    if (contentful.length < CATALOG_MIN_VALUES) return false;
    const hu = contentful.filter((v) => isLikelyHu(v.trim())).length;
    return hu / contentful.length >= CATALOG_DENSITY;
  };

  // A string literal may itself be a JSON catalog blob. Parse it, and keep its
  // values (all of them if HU-dense, else only the Hungarian ones).
  const handleString = (raw) => {
    if (typeof raw !== 'string') return;
    const t = raw.trim();
    if (t.length > 20 && (t[0] === '{' || t[0] === '[')) {
      let parsed = null;
      try { parsed = JSON.parse(t); } catch { /* not JSON */ }
      if (parsed && typeof parsed === 'object') {
        const bag = [];
        collectStringValues(parsed, bag);
        const dense = isCatalog(bag);
        for (const v of bag) consider(v, dense, true); // catalog source -> _common
        return;
      }
    }
    consider(raw, false, false);
  };

  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }

    // HU-dense object literal -> treat as a catalog, keep all string values.
    if (node.type === 'ObjectExpression') {
      const values = [];
      for (const p of node.properties) {
        if (p.type !== 'Property' || !p.value) continue;
        if (p.value.type === 'Literal' && typeof p.value.value === 'string') {
          values.push(p.value.value);
        } else if (p.value.type === 'TemplateLiteral' && p.value.expressions.length === 0) {
          values.push(p.value.quasis.map((q) => q.value.cooked).join(''));
        }
      }
      if (isCatalog(values)) for (const v of values) consider(v, true, true); // catalog -> _common
    }

    if (node.type === 'Property' && !node.computed && node.value) {
      const k = node.key && (node.key.name ?? node.key.value);
      const isUi = UI_TEXT_KEYS.has(k);
      if (node.value.type === 'Literal' && typeof node.value.value === 'string') {
        if (isUi) consider(node.value.value, true, false); // inline component label
        else handleString(node.value.value);
      } else if (node.value.type === 'TemplateLiteral') {
        for (const q of node.value.quasis) consider(q.value.cooked, isUi, false);
      }
    } else if (node.type === 'Literal' && typeof node.value === 'string') {
      handleString(node.value);
    } else if (node.type === 'TemplateLiteral') {
      for (const q of node.quasis) consider(q.value.cooked, false, false);
    }

    for (const key in node) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
      const child = node[key];
      if (child && typeof child === 'object') walk(child);
    }
  })(ast);

  return { strings: out, catalog };
}
