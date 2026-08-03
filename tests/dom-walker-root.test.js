// tests/dom-walker-root.test.js
// The walk is rooted at document.documentElement in production (src/content.js),
// not at <body>: the browser tab title is a text node inside <head>. These tests
// pin down that <head> is safe at that root — the tab title is translated and
// everything else in <head> is left exactly as the page wrote it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadBillingoTranslator } from './load-script.js';

function setup(headHtml, bodyHtml) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html lang="hu"><head>${headHtml}</head><body>${bodyHtml}</body></html>`
  );
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
  'Bejelentkezés - Billingo': 'Connexion - Billingo',
  'Számlák - Billingo': 'Factures - Billingo',
  'Számlák': 'Factures',
  'Bezár': 'Fermer',
};

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}

test('rooted at documentElement: translates the <title> text node', () => {
  const { doc, bt } = setup('<title>Bejelentkezés - Billingo</title>', '<h1>Számlák</h1>');
  const stats = bt.createStats();

  bt.walkAndTranslate(doc.documentElement, bt.createTranslator(dict), stats);

  assert.equal(doc.title, 'Connexion - Billingo');
  assert.equal(doc.querySelector('h1').textContent, 'Factures', 'the body is still walked');
});

test('rooted at documentElement: restores the <title> when switching back to Hungarian', () => {
  const { doc, bt } = setup('<title>Bejelentkezés - Billingo</title>', '');
  const stats = bt.createStats();

  bt.walkAndTranslate(doc.documentElement, bt.createTranslator(dict), stats);
  assert.equal(doc.title, 'Connexion - Billingo');

  bt.walkAndTranslate(doc.documentElement, () => null, stats); // restoreTranslator
  assert.equal(doc.title, 'Bejelentkezés - Billingo');
});

test('rooted at documentElement: damages nothing else in <head>', () => {
  // Injected analytics/consent scripts and vue-meta styles must survive intact,
  // <meta content> is not a translatable attribute, and <link title> names an
  // alternate-stylesheet set rather than visible text.
  const { doc, bt } = setup(
    '<title>Számlák - Billingo</title>' +
    '<meta name="description" content="Számlák">' +
    '<link rel="alternate stylesheet" title="Bezár" href="x.css">' +
    '<script>var label = "Számlák";</script>' +
    '<style>/* Bezár */</style>',
    ''
  );
  const stats = bt.createStats();

  bt.walkAndTranslate(doc.documentElement, bt.createTranslator(dict), stats);

  assert.equal(doc.title, 'Factures - Billingo');
  assert.equal(doc.querySelector('meta').getAttribute('content'), 'Számlák');
  assert.equal(doc.querySelector('link').getAttribute('title'), 'Bezár');
  assert.equal(doc.querySelector('head script').textContent, 'var label = "Számlák";');
  assert.equal(doc.querySelector('head style').textContent, '/* Bezár */');
  assert.equal(doc.documentElement.getAttribute('lang'), 'hu');
});

test('observer rooted at documentElement re-translates a document.title assignment', async () => {
  // vue-meta sets document.title on every route change. Depending on the engine
  // that is a childList replacement (a brand-new Text node) or a characterData
  // update; both must be caught.
  const { doc, bt } = setup('<title>Bezár</title>', '');
  const obs = bt.installObserver(doc.documentElement, bt.createTranslator(dict), bt.createStats());

  doc.title = 'Bejelentkezés - Billingo';
  for (let i = 0; i < 50 && doc.title !== 'Connexion - Billingo'; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(doc.title, 'Connexion - Billingo');

  // characterData path: write straight into the existing text node.
  doc.querySelector('title').firstChild.nodeValue = 'Számlák - Billingo';
  for (let i = 0; i < 50 && doc.title !== 'Factures - Billingo'; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(doc.title, 'Factures - Billingo');

  obs.disconnect();
});

test('observer rooted at documentElement ignores injected head scripts and styles', async () => {
  const { doc, bt } = setup('<title>Bezár</title>', '');
  const obs = bt.installObserver(doc.documentElement, bt.createTranslator(dict), bt.createStats());

  for (let i = 0; i < 3; i++) {
    const script = doc.createElement('script');
    script.textContent = 'window.tag = "Számlák";';
    doc.head.appendChild(script);
    const style = doc.createElement('style');
    style.textContent = '/* Bezár */';
    doc.head.appendChild(style);
  }
  await settle();

  for (const script of doc.querySelectorAll('head script')) {
    assert.equal(script.textContent, 'window.tag = "Számlák";');
  }
  for (const style of doc.querySelectorAll('head style')) {
    assert.equal(style.textContent, '/* Bezár */');
  }
  assert.equal(bt.getDevCounters().volatile, 0, 'nothing was fought over');
  assert.equal(bt.getDevCounters().circuitBreaks, 0, 'no flood from head injections');
  obs.disconnect();
});
