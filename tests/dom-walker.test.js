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
  return { dom, doc: win.document, bt };
}

const dict = {
  'Számlák': 'Invoices',
  'Új számla': 'New invoice',
  'Bezár': 'Close',
  'Beállítások': 'Settings',
};

test('walkAndTranslate: replaces matching text nodes', () => {
  const { doc, bt } = setup('<h1>Számlák</h1><p>Beállítások</p>');
  const translate = bt.createTranslator(dict);
  const stats = bt.createStats();

  bt.walkAndTranslate(doc.body, translate, stats);

  assert.equal(doc.querySelector('h1').textContent, 'Invoices');
  assert.equal(doc.querySelector('p').textContent, 'Settings');
  assert.equal(stats.hits, 2);
});

test('walkAndTranslate: leaves unmatched text untouched and records misses', () => {
  const { doc, bt } = setup('<p>Random user data</p><p>Számlák</p>');
  const translate = bt.createTranslator(dict);
  const stats = bt.createStats();

  bt.walkAndTranslate(doc.body, translate, stats);

  assert.equal(doc.querySelectorAll('p')[0].textContent, 'Random user data');
  assert.equal(doc.querySelectorAll('p')[1].textContent, 'Invoices');
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.deepEqual([...stats.uniqueMisses], ['Random user data']);
});

test('walkAndTranslate: translates placeholder, title, aria-label, alt', () => {
  const { doc, bt } = setup(`
    <input placeholder="Számlák">
    <span title="Bezár">x</span>
    <button aria-label="Beállítások">⚙</button>
    <img alt="Számlák" src="x.png">
  `);
  const translate = bt.createTranslator(dict);
  const stats = bt.createStats();

  bt.walkAndTranslate(doc.body, translate, stats);

  assert.equal(doc.querySelector('input').getAttribute('placeholder'), 'Invoices');
  assert.equal(doc.querySelector('span').getAttribute('title'), 'Close');
  assert.equal(doc.querySelector('button').getAttribute('aria-label'), 'Settings');
  assert.equal(doc.querySelector('img').getAttribute('alt'), 'Invoices');
});

test('walkAndTranslate: translates value on submit/button inputs only, never text inputs', () => {
  const { doc, bt } = setup(`
    <input type="submit" value="Bezár">
    <input type="button" value="Bezár">
    <input type="text" value="Bezár">
  `);
  const translate = bt.createTranslator(dict);
  const stats = bt.createStats();

  bt.walkAndTranslate(doc.body, translate, stats);

  assert.equal(doc.querySelectorAll('input')[0].getAttribute('value'), 'Close');
  assert.equal(doc.querySelectorAll('input')[1].getAttribute('value'), 'Close');
  // text input value untouched (would corrupt user data)
  assert.equal(doc.querySelectorAll('input')[2].getAttribute('value'), 'Bezár');
});

test('walkAndTranslate: skips <script> and <style> contents', () => {
  const { doc, bt } = setup('<script>const x = "Számlák";</script><style>/* Bezár */</style>');
  const translate = bt.createTranslator(dict);
  const stats = bt.createStats();

  bt.walkAndTranslate(doc.body, translate, stats);

  assert.equal(doc.querySelector('script').textContent, 'const x = "Számlák";');
  assert.equal(doc.querySelector('style').textContent, '/* Bezár */');
  assert.equal(stats.hits, 0);
});

test('walkAndTranslate: preserves whitespace around translated text', () => {
  const { doc, bt } = setup('<button>  Számlák  </button>');
  const translate = bt.createTranslator(dict);
  const stats = bt.createStats();

  bt.walkAndTranslate(doc.body, translate, stats);

  assert.equal(doc.querySelector('button').textContent, '  Invoices  ');
});

test('walkAndTranslate: re-walking with different dict re-translates from original HU', () => {
  const { doc, bt } = setup('<h1>Számlák</h1><p>Bezár</p>');
  const enTranslate = bt.createTranslator({ 'Számlák': 'Invoices', 'Bezár': 'Close' });
  const frTranslate = bt.createTranslator({ 'Számlák': 'Factures', 'Bezár': 'Fermer' });
  const stats = bt.createStats();

  bt.walkAndTranslate(doc.body, enTranslate, stats);
  assert.equal(doc.querySelector('h1').textContent, 'Invoices');
  assert.equal(doc.querySelector('p').textContent, 'Close');

  // Switch to FR — must re-translate from original HU, not from EN.
  stats.reset();
  bt.walkAndTranslate(doc.body, frTranslate, stats);
  assert.equal(doc.querySelector('h1').textContent, 'Factures');
  assert.equal(doc.querySelector('p').textContent, 'Fermer');
});

test('walkAndTranslate: re-walking with always-null translator restores original HU', () => {
  const { doc, bt } = setup('<h1>Számlák</h1><button placeholder="Bezár">Beállítások</button>');
  const translate = bt.createTranslator({ 'Számlák': 'Invoices', 'Bezár': 'Close', 'Beállítások': 'Settings' });
  const restore = () => null;
  const stats = bt.createStats();

  bt.walkAndTranslate(doc.body, translate, stats);
  assert.equal(doc.querySelector('h1').textContent, 'Invoices');
  assert.equal(doc.querySelector('button').textContent, 'Settings');
  assert.equal(doc.querySelector('button').getAttribute('placeholder'), 'Close');

  stats.reset();
  bt.walkAndTranslate(doc.body, restore, stats);
  assert.equal(doc.querySelector('h1').textContent, 'Számlák');
  assert.equal(doc.querySelector('button').textContent, 'Beállítások');
  assert.equal(doc.querySelector('button').getAttribute('placeholder'), 'Bezár');
});

test('installObserver: translates dynamically added subtrees', async () => {
  const { doc, bt } = setup('<div id="root"></div>');
  const translate = bt.createTranslator(dict);
  const stats = bt.createStats();

  const obs = bt.installObserver(doc.body, translate, stats);

  const root = doc.getElementById('root');
  const h1 = doc.createElement('h1');
  h1.textContent = 'Számlák';
  root.appendChild(h1);

  // MutationObserver fires asynchronously, then our handler defers via
  // setTimeout(0)/requestIdleCallback for batching. Poll until processed.
  for (let i = 0; i < 50 && h1.textContent !== 'Invoices'; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.equal(h1.textContent, 'Invoices');
  obs.disconnect();
});

// Simulates a framework that reverts our translation back to HU, forcing
// repeated re-translations of the same node — the freeze scenario.
test('per-node cap: stops re-translating a looping node after K flips', () => {
  const { doc, bt } = setup('<span>Számla</span>');
  const translate = bt.createTranslator({ 'Számla': 'Invoice' });
  const stats = bt.createStats();
  const node = doc.querySelector('span').firstChild;

  for (let i = 0; i < 10; i++) {
    node.nodeValue = 'Számla';                 // framework revert
    bt.walkAndTranslate(doc.body, translate, stats); // small DOM -> synchronous
  }
  // After the cap (K=5) is exceeded the node is marked volatile and left in HU.
  assert.equal(node.nodeValue, 'Számla');
  assert.ok(bt.getDevCounters().volatile >= 1, 'a node became volatile');
});

test('walk is idempotent (no-op-by-equality on already-translated nodes)', () => {
  const { doc, bt } = setup('<span>Számla</span>');
  const translate = bt.createTranslator({ 'Számla': 'Invoice' });
  const stats = bt.createStats();
  bt.walkAndTranslate(doc.body, translate, stats);
  bt.walkAndTranslate(doc.body, translate, stats); // second pass: no corruption
  assert.equal(doc.querySelector('span').textContent, 'Invoice');
  assert.equal(bt.getDevCounters().volatile, 0);
});

test('time-slice: processes in chunks via an injected scheduler', () => {
  const { doc, bt } = setup('<span>Számla</span>'.repeat(10));
  const body = doc.body;
  const translate = bt.createTranslator({ 'Számla': 'Invoice' });
  const stats = bt.createStats();

  // Manual scheduler: queue the slice callbacks instead of running them async.
  const queue = [];
  const opts = { sliceSize: 3, schedule: (cb) => queue.push(cb) };

  bt.walkAndTranslate(body, translate, stats, opts); // first slice runs synchronously
  assert.ok(queue.length > 0, 'remaining work was scheduled, not run all at once');
  while (queue.length) queue.shift()();              // drain remaining slices

  const translated = [...body.querySelectorAll('span')].filter((s) => s.textContent === 'Invoice');
  assert.equal(translated.length, 10);
});

test('circuit-breaker: trips on a mutation flood and increments the counter', async () => {
  const { doc, bt } = setup('<div id="r"></div>');
  const root = doc.getElementById('r');
  const translate = bt.createTranslator({ 'Számla': 'Invoice' });
  const stats = bt.createStats();
  const before = bt.getDevCounters().circuitBreaks;
  const obs = bt.installObserver(root, translate, stats, { floodThreshold: 50, cooldownMs: 10 });
  for (let i = 0; i < 200; i++) {            // flood with appends
    const s = doc.createElement('span'); s.textContent = 'x'; root.appendChild(s);
  }
  await new Promise((r) => setTimeout(r, 0)); // let the observer callback run
  obs.disconnect();
  assert.ok(bt.getDevCounters().circuitBreaks > before, 'circuit-breaker tripped');
});
