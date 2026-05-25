import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractRenderedStrings } from '../tools/snapshot-walker.js';

function dom(html) {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;
}

test('extrait les nœuds texte, trim, dédup', () => {
  const doc = dom('<h1>  Számlák </h1><p>Számlák</p><span>Új tétel</span>');
  const out = extractRenderedStrings(doc).sort();
  assert.deepEqual(out, ['Számlák', 'Új tétel']);
});

test('extrait les attributs traduisibles + value des boutons', () => {
  const doc = dom('<input placeholder="Keresés"><input type="submit" value="Mentés"><input type="text" value="ne pas prendre">');
  const out = extractRenderedStrings(doc).sort();
  assert.ok(out.includes('Keresés'));
  assert.ok(out.includes('Mentés'));
  assert.ok(!out.includes('ne pas prendre'));
});

test('saute script/style', () => {
  const doc = dom('<script>const x="Számlák"</script><style>.a{}</style><p>Bezár</p>');
  assert.deepEqual(extractRenderedStrings(doc), ['Bezár']);
});
