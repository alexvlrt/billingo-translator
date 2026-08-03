// tests/dom-walker-observer.test.js
// Flood circuit-breaker: it must be a pause, not a death sentence. A single
// mutation storm used to kill the observer for the page's whole lifetime,
// because the breaker's internal disconnect went through the public teardown
// wrapper and marked the observer destroyed, so the cooldown returned early.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLOOD_SIZE = 60;

// Append enough nodes in one turn to blow past the injected threshold.
function flood(doc, root) {
  const spans = [];
  for (let i = 0; i < FLOOD_SIZE; i++) {
    const span = doc.createElement('span');
    span.textContent = 'Számla';
    root.appendChild(span);
    spans.push(span);
  }
  return spans;
}

test('circuit-breaker: resettles after the cooldown and translates the storm', async () => {
  const { doc, bt } = setup('<div id="r"></div>');
  const root = doc.getElementById('r');
  const translate = bt.createTranslator({ 'Számla': 'Invoice' });
  const obs = bt.installObserver(root, translate, bt.createStats(), {
    floodThreshold: 20, cooldownMs: 20,
  });

  const spans = flood(doc, root);
  for (let i = 0; i < 100 && spans.some((s) => s.textContent !== 'Invoice'); i++) await sleep(5);

  // The resettle walk's own writes also count toward the flood budget, so at a
  // test-sized threshold the breaker can trip again — it converges anyway,
  // because the next pass is a no-op-by-equality and emits no records.
  assert.ok(bt.getDevCounters().circuitBreaks >= 1, 'the breaker tripped');
  assert.equal(
    spans.filter((s) => s.textContent === 'Invoice').length,
    FLOOD_SIZE,
    'the resettle walk translated everything the storm dropped'
  );
  obs.disconnect();
});

test('circuit-breaker: the observer works again after a resettle', async () => {
  const { doc, bt } = setup('<div id="r"></div>');
  const root = doc.getElementById('r');
  const translate = bt.createTranslator({ 'Számla': 'Invoice' });
  const obs = bt.installObserver(root, translate, bt.createStats(), {
    floodThreshold: 20, cooldownMs: 20,
  });

  flood(doc, root);
  await sleep(80); // past the cooldown: observing again

  const late = doc.createElement('p');
  late.textContent = 'Számla';
  root.appendChild(late);
  for (let i = 0; i < 50 && late.textContent !== 'Invoice'; i++) await sleep(5);

  assert.equal(late.textContent, 'Invoice', 'dynamic translation survived the storm');
  obs.disconnect();
});

test('circuit-breaker: an external disconnect during the cooldown cancels the resettle', async () => {
  // Teardown must stay permanent, or a language switch would leave a zombie walk
  // racing the new one.
  const { doc, bt } = setup('<div id="r"></div>');
  const root = doc.getElementById('r');
  const translate = bt.createTranslator({ 'Számla': 'Invoice' });
  const obs = bt.installObserver(root, translate, bt.createStats(), {
    floodThreshold: 20, cooldownMs: 60,
  });

  const spans = flood(doc, root);
  await sleep(0); // the observer callback (a microtask) has run: breaker tripped
  assert.equal(bt.getDevCounters().circuitBreaks, 1);

  obs.disconnect();
  await sleep(120); // well past the cooldown

  assert.ok(
    spans.every((s) => s.textContent === 'Számla'),
    'nothing was translated after teardown'
  );
});
