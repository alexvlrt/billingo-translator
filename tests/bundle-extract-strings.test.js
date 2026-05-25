import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractStrings } from '../tools/bundle/extract-strings.js';
import { looksLikeNoise, makeHuFilter } from '../tools/lib/filters.js';

const isLikelyHu = makeHuFilter(new Set(), new Set());
const src = fs.readFileSync(new URL('./fixtures/sample-chunk.js', import.meta.url), 'utf8');

test('keeps accented Hungarian literals + template strings', () => {
  const { strings: out } = extractStrings(src, { isLikelyHu, looksLikeNoise });
  assert.ok(out.has('Számla létrehozása'));
  assert.ok(out.has('Előfordulhat, hogy a módosításaid nem kerülnek mentésre.'));
  assert.ok(out.has('Üdvözlünk a Billingóban'));
});

test('keeps accent-less UI-text property values (label:"API kulcs")', () => {
  const { strings: out } = extractStrings(src, { isLikelyHu, looksLikeNoise });
  assert.ok(out.has('API kulcs'), 'label value kept despite no accents');
});

test('drops code noise and non-UI accent-less identifiers', () => {
  const { strings: out } = extractStrings(src, { isLikelyHu, looksLikeNoise });
  assert.ok(!out.has('snake_case_id'));
  assert.ok(!out.has('code_token'));
  assert.ok(!out.has('https://example.com/n/foo'));
  assert.ok(!out.has('OK'));
});

test('emits tag-stripped fragments from HTML literals', () => {
  const { strings: out } = extractStrings(src, { isLikelyHu, looksLikeNoise });
  assert.ok(out.has('Amennyiben ügyeket szeretnél, válaszd a'));
  assert.ok(out.has('Pro csomagot'));
});

test('parses an HU-dense JSON-string catalog blob: accent-less values + markup fragments', () => {
  // Billingo embeds an i18n catalog as ONE string literal whose value is JSON.
  const catalog = JSON.stringify({
    'Label:api_key': 'API kulcs',                 // accent-less UI value
    'Api:create': 'Új API kulcs hozzáadása',      // accented
    'doc.tip': 'Amennyiben ügyeket szeretnél, válaszd a <a href="/x">Pro csomagot</a>!',
  });
  const blobSrc = 'var L=' + JSON.stringify(catalog) + ';';
  const { strings: out, catalog: cat } = extractStrings(blobSrc, { isLikelyHu, looksLikeNoise });
  assert.ok(out.has('API kulcs'), 'accent-less catalog value kept (HU-dense blob)');
  assert.ok(out.has('Új API kulcs hozzáadása'));
  assert.ok(out.has('Pro csomagot'), 'markup fragment harvested from a blob value');
  // Catalog-sourced strings are tagged so the caller can route them to _common.
  assert.ok(cat.has('API kulcs'), 'blob values are tagged as catalog');
});

test('does not keep accent-less values from a non-Hungarian JSON blob (CSS/config)', () => {
  const cfg = JSON.stringify({ padding: '5px', align: 'center', color: 'red', position: 'absolute' });
  const blobSrc = 'var S=' + JSON.stringify(cfg) + ';';
  const { strings: out } = extractStrings(blobSrc, { isLikelyHu, looksLikeNoise });
  assert.ok(!out.has('center'));
  assert.ok(!out.has('absolute'));
});

test('keeps accent-less values from an HU-dense object literal', () => {
  const objSrc = 'var o={"Label:api_key":"API kulcs",a:"Új számla",b:"Mentés sikeres",c:"Törlés megerősítése"};';
  const { strings: out } = extractStrings(objSrc, { isLikelyHu, looksLikeNoise });
  assert.ok(out.has('API kulcs'), 'accent-less value kept in HU-dense object');
});
