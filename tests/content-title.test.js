// tests/content-title.test.js
// The browser tab's title lives in <head>, outside <body>: src/content.js walks
// and observes from document.documentElement so <title> is reached. These tests
// drive the real wiring of content.js (storage → shard loader → walker) under
// jsdom and assert on document.title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadBillingoTranslator } from './load-script.js';

const HU_TITLE = 'Számlák - Billingo';
const EN_TITLE = 'Invoices - Billingo';

const INDEX = [{ prefix: '/n/document', shard: 'documents' }];
const SHARDS = {
  _common: {
    [HU_TITLE]: EN_TITLE,
    'Partnerek - Billingo': 'Partners - Billingo', // an SPA route change retitles the tab
    'Mentés': 'Save',
  },
  documents: { 'Számlák': 'Invoices' },
};

// <head> must survive the walk untouched: SCRIPT text is rejected by the walker
// and `content` is not a translatable attribute. Both are asserted below.
const HEAD_EXTRAS =
  `<meta name="description" content="Számlák">` +
  `<script type="application/json">{"label":"Számlák"}</script>`;

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function setup({ lang = 'en', path = '/n/document/invoice/list' } = {}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head><title>${HU_TITLE}</title>${HEAD_EXTRAS}</head>` +
    `<body><h1>Számlák</h1></body></html>`,
    { url: `https://app.billingo.hu${path}` }
  );
  const win = dom.window;

  // Serve the dictionary from memory: getURL is the identity, so a fetch URL is
  // just the extension-relative path.
  const files = {
    'dict/_index.json': INDEX,
    'dict/en/_common.json': SHARDS._common,
    'dict/en/documents.json': SHARDS.documents,
  };
  const fetchStub = async (url) => {
    const body = files[url];
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };

  const messageListeners = [];
  const chrome = {
    runtime: {
      getURL: (p) => p,
      getManifest: () => ({ version: '1.0.0' }),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
    storage: {
      sync: { get: async () => ({ lang }) },
      onChanged: { addListener: () => {} },
    },
  };

  // spa-router is replaced by a stub: it would install a real polling interval
  // that outlives the test. Pre-seeding BillingoTranslator works because every
  // src/ file does `globalThis.BillingoTranslator || {}`.
  let routeCallback = null;
  const seeded = { onRouteChange: (cb) => { routeCallback = cb; return () => {}; } };

  const bt = loadBillingoTranslator(
    ['src/translator.js', 'src/dom-walker.js', 'src/shard-loader.js', 'src/content.js'],
    {
      BillingoTranslator: seeded,
      chrome,
      document: win.document,
      location: win.location,
      MutationObserver: win.MutationObserver,
      Node: win.Node,
      NodeFilter: win.NodeFilter,
      fetch: fetchStub,
      console,
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (id) => clearTimeout(id),
      // Runs the walker's time slices and content.js's zone prefetch promptly
      // instead of on the 1 s setTimeout fallback, so no timer outlives the test.
      requestIdleCallback: (cb) => setTimeout(cb, 0),
    }
  );

  return { bt, doc: win.document, messageListeners, routeCallback: () => routeCallback };
}

const sendMessage = (listener, msg) =>
  new Promise((resolve) => { listener(msg, null, resolve); });

test('translates the tab title, which lives outside <body>', async () => {
  // Arrange + Act: content.js self-initialises on load.
  const { doc } = setup();
  await tick();

  // Assert
  assert.equal(doc.title, EN_TITLE);
  assert.equal(doc.querySelector('h1').textContent, 'Invoices'); // body still walked
});

test('leaves the rest of <head> alone', async () => {
  const { doc } = setup();
  await tick();

  // <meta content> is not in the walker's translatable-attribute list, and
  // SCRIPT text is rejected outright — a documentElement-rooted walk is safe.
  assert.equal(doc.querySelector('meta[name=description]').getAttribute('content'), 'Számlák');
  assert.match(doc.querySelector('script').textContent, /"Számlák"/);
});

test('translates a title the SPA sets after the first walk', async () => {
  // The observer is rooted at documentElement too, so a navigation that retitles
  // the tab is picked up.
  const { doc } = setup();
  await tick();

  doc.title = 'Partnerek - Billingo';
  await tick();

  assert.equal(doc.title, 'Partners - Billingo');
});

test('restores the Hungarian title when switching back to hu', async () => {
  const { doc, messageListeners } = setup();
  await tick();
  assert.equal(doc.title, EN_TITLE);

  const res = await sendMessage(messageListeners[0], { type: 'setLang', lang: 'hu' });
  await tick();

  assert.equal(res.ok, true);
  assert.equal(doc.title, HU_TITLE); // from the walker's remembered original
});

test('re-walks the title after a route change', async () => {
  const { doc, routeCallback } = setup();
  await tick();

  const onRoute = routeCallback();
  assert.equal(typeof onRoute, 'function'); // registered for the tab's lifetime
  doc.title = HU_TITLE; // the SPA rewrote the tab title on navigation
  await onRoute('/n/document/create/invoice');
  await tick();

  assert.equal(doc.title, EN_TITLE);
});
