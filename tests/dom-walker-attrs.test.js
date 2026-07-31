// tests/dom-walker-attrs.test.js
// Attribute surface of the walker: which tags may contribute attributes, and
// which attributes are translated. Text-node behaviour lives in dom-walker.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadBillingoTranslator } from './load-script.js';

function setup(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const win = dom.window;
  const bt = loadBillingoTranslator(
    ['src/translator.js', 'src/dom-walker.js'],
    {
      document: win.document,
      MutationObserver: win.MutationObserver,
      Node: win.Node,
      NodeFilter: win.NodeFilter,
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (id) => clearTimeout(id),
    }
  );
  return { doc: win.document, bt };
}

const dict = {
  'Számlák': 'Factures',
  'Megjegyzés': 'Remarque',
  'Bezár': 'Fermer',
  'Ügyfelek': 'Clients',
};

function walk(doc, bt) {
  bt.walkAndTranslate(doc.body, bt.createTranslator(dict), bt.createStats());
}

test('translates a textarea placeholder while leaving its content alone', () => {
  // The content is user data (an invoice comment); the placeholder is UI chrome.
  const { doc, bt } = setup('<textarea placeholder="Megjegyzés">Számlák</textarea>');
  walk(doc, bt);

  const el = doc.querySelector('textarea');
  assert.equal(el.getAttribute('placeholder'), 'Remarque');
  assert.equal(el.textContent, 'Számlák');
});

test('translates aria-placeholder and aria-description', () => {
  const { doc, bt } = setup(
    '<div role="textbox" aria-placeholder="Megjegyzés" aria-description="Bezár"></div>'
  );
  walk(doc, bt);

  const el = doc.querySelector('div');
  assert.equal(el.getAttribute('aria-placeholder'), 'Remarque');
  assert.equal(el.getAttribute('aria-description'), 'Fermer');
});

test('translates an optgroup label', () => {
  const { doc, bt } = setup('<select><optgroup label="Ügyfelek"></optgroup></select>');
  walk(doc, bt);

  assert.equal(doc.querySelector('optgroup').getAttribute('label'), 'Clients');
});

test('never touches attributes on script, style or noscript', () => {
  const { doc, bt } = setup(
    '<script title="Bezár"></script><style title="Bezár"></style><noscript title="Bezár"></noscript>'
  );
  walk(doc, bt);

  for (const tag of ['script', 'style', 'noscript']) {
    assert.equal(doc.querySelector(tag).getAttribute('title'), 'Bezár');
  }
});

test('restores a textarea placeholder when switching back to Hungarian', () => {
  const { doc, bt } = setup('<textarea placeholder="Megjegyzés"></textarea>');
  const stats = bt.createStats();
  bt.walkAndTranslate(doc.body, bt.createTranslator(dict), stats);
  assert.equal(doc.querySelector('textarea').getAttribute('placeholder'), 'Remarque');

  bt.walkAndTranslate(doc.body, () => null, stats); // restoreTranslator
  assert.equal(doc.querySelector('textarea').getAttribute('placeholder'), 'Megjegyzés');
});
