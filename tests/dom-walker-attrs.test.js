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
  'Adószám': 'Numéro fiscal',
};

function walk(doc, bt) {
  bt.walkAndTranslate(doc.body, bt.createTranslator(dict), bt.createStats());
}

// The walker must hand the emitted translation to stats, or our own output comes
// back as a miss. Bootstrap renders .tooltip-inner from the already-translated
// stashed `title`, so that output reappears as a brand-new text node — it used to
// land in the exported "untranslated Hungarian" list and depress the coverage
// percentage. Reverting either recordHit call site to the one-argument form left the
// whole suite green, which is why these two tests exist.
test('the walker reports the emitted translation to stats (text nodes)', () => {
  const { doc, bt } = setup('<p>Számlák</p>');
  const stats = bt.createStats();
  bt.walkAndTranslate(doc.body, bt.createTranslator(dict), stats);
  assert.equal(doc.querySelector('p').textContent, 'Factures');

  // Now the framework injects our own output as fresh content.
  doc.body.insertAdjacentHTML('beforeend', '<span>Factures</span>');
  bt.walkAndTranslate(doc.body, bt.createTranslator(dict), stats);

  assert.equal(stats.misses, 0, 'our own output must not be counted as a miss');
  assert.deepEqual([...stats.uniqueMisses], [],
    'our own output must never reach the exported miss list');
});

test('the walker reports the emitted translation to stats (attributes)', () => {
  const { doc, bt } = setup('<button title="Adószám">x</button>');
  const stats = bt.createStats();
  bt.walkAndTranslate(doc.body, bt.createTranslator(dict), stats);
  assert.equal(doc.querySelector('button').getAttribute('title'), 'Numéro fiscal');

  // Exactly what Bootstrap does: render the stashed (translated) title as text.
  doc.body.insertAdjacentHTML('beforeend', '<div class="tooltip-inner">Numéro fiscal</div>');
  bt.walkAndTranslate(doc.body, bt.createTranslator(dict), stats);

  assert.equal(stats.uniqueMisses.has('Numéro fiscal'), false);
  assert.equal(stats.uniqueMisses.has('x'), true, 'a genuine miss is still recorded');
});

// Wraps a translator to record every lookup, so a test can prove the observer
// did NOT re-process a value we wrote ourselves.
function countingTranslator(bt, table) {
  const inner = bt.createTranslator(table);
  const fn = (text) => { fn.calls.push(text); return inner(text); };
  fn.calls = [];
  return fn;
}

// The observer fires asynchronously and our handler defers once more for
// batching, so give both a few turns before asserting.
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}

// Bootstrap 4's Tooltip._fixTitle(): move `title` into the stash, blank `title`.
function fixTitle(el) {
  el.setAttribute('data-original-title', el.getAttribute('title') || '');
  el.setAttribute('title', '');
}

// Bootstrap 4's Tooltip._restoreTitle(): copy the stash back, drop the stash.
// Verbatim shape of the real thing — this is the write that used to poison the
// remembered Hungarian original.
function restoreTitle(el) {
  el.setAttribute('title', el.getAttribute('data-original-title') || '');
  el.removeAttribute('data-original-title');
}

// Stand-in for src/content.js's live translator: one stable function whose
// dictionary grows as shards land and whose language the popup can switch.
function liveTranslator(initial) {
  const state = { table: initial };
  const fn = (text) => (state.table[text] ? state.table[text] : null);
  fn.use = (table) => { state.table = table; };
  return fn;
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

test('an empty dictionary value leaves the attribute in Hungarian', () => {
  // Empty value means miss, never blank output — at every layer, attributes included.
  const { doc, bt } = setup('<button title="Bezár" aria-label="Bezár"></button>');
  bt.walkAndTranslate(doc.body, bt.createTranslator({ 'Bezár': '' }), bt.createStats());

  const el = doc.querySelector('button');
  assert.equal(el.getAttribute('title'), 'Bezár');
  assert.equal(el.getAttribute('aria-label'), 'Bezár');
});

// --- machine-value tags ------------------------------------------------------
// These only became reachable once the walk was rooted at documentElement.

test('never writes translatable attributes on link, meta, base or html', () => {
  const { doc, bt } = setup('');
  // `<link title>` names an alternate-stylesheet set, not visible text.
  const link = doc.createElement('link');
  link.setAttribute('rel', 'alternate stylesheet');
  link.setAttribute('title', 'Bezár');
  doc.head.appendChild(link);
  const meta = doc.createElement('meta');
  meta.setAttribute('title', 'Bezár');
  doc.head.appendChild(meta);
  const base = doc.createElement('base');
  base.setAttribute('title', 'Bezár');
  doc.head.appendChild(base);
  doc.documentElement.setAttribute('title', 'Bezár');

  bt.walkAndTranslate(doc.documentElement, bt.createTranslator(dict), bt.createStats());

  assert.equal(link.getAttribute('title'), 'Bezár');
  assert.equal(meta.getAttribute('title'), 'Bezár');
  assert.equal(base.getAttribute('title'), 'Bezár');
  assert.equal(doc.documentElement.getAttribute('title'), 'Bezár');
});

// --- data-original-title: Bootstrap 4's tooltip stash -----------------------
// We deliberately never write it. It is a copy of `title` that Bootstrap hands
// back through `title` on hide, so translating it made our own output the
// element's remembered "original".

test('never writes or reports data-original-title', async () => {
  const { doc, bt } = setup('<button data-original-title="Megjegyzés" title=""></button>');
  const el = doc.querySelector('button');
  const translate = countingTranslator(bt, dict);
  const stats = bt.createStats();
  const obs = bt.installObserver(doc.body, translate, stats);

  bt.walkAndTranslate(doc.body, translate, stats);
  el.setAttribute('data-original-title', 'Bezár'); // framework re-stash
  await settle();

  assert.equal(el.getAttribute('data-original-title'), 'Bezár', 'the stash is the framework’s');
  assert.equal(el.getAttribute('title'), '', 'the blank title is the framework’s state too');
  assert.deepEqual(translate.calls, [], 'the stash is never even looked up');
  assert.equal(stats.hits, 0);
  assert.deepEqual([...stats.uniqueMisses], []);
  obs.disconnect();
});

test('a tooltip initialised before our first walk is translated after the first hide', async () => {
  // The coverage we give up by ignoring the stash, and its self-healing: Bootstrap
  // ran first, so the Hungarian sits in the stash and `title` is blank — that first
  // pop-up shows Hungarian (the rendered .tooltip-inner text node is the observer's
  // job). On hide, _restoreTitle() hands the Hungarian back through `title`, which
  // we do translate, so every later pop-up is translated.
  const { doc, bt } = setup('<button data-original-title="Adószám" title=""></button>');
  const el = doc.querySelector('button');
  const stats = bt.createStats();
  const translate = bt.createTranslator(dict);
  const obs = bt.installObserver(doc.body, translate, stats);

  bt.walkAndTranslate(doc.body, translate, stats);
  assert.equal(el.getAttribute('data-original-title'), 'Adószám', 'first pop-up: Hungarian');

  restoreTitle(el); // user moves away
  await settle();
  assert.equal(el.getAttribute('title'), 'Numéro fiscal', 'translated on the way back');

  fixTitle(el); // hovers again: Bootstrap stashes the translation
  assert.equal(el.getAttribute('data-original-title'), 'Numéro fiscal');

  bt.walkAndTranslate(doc.body, () => null, stats); // popup: back to Hungarian
  restoreTitle(el);                                 // user moves away
  await settle();
  // What _restoreTitle() put back is byte-identical to the last value we wrote to
  // `title`, so the observer's own-write guard drops the record — the attribute can
  // lag one language behind until the next full walk (route change, zone landing,
  // language switch) re-evaluates it from the remembered original. The remembered
  // original is what matters, and it is intact.
  bt.walkAndTranslate(doc.body, () => null, stats);
  assert.equal(el.getAttribute('title'), 'Adószám', 'still switchable');
  obs.disconnect();
});

test('a blank attribute is never remembered as the original', async () => {
  // `:title` bound to a value that has not loaded yet is blank on our first walk.
  // Remembering "" as its original would make every later value untranslatable,
  // because the remembered original is what we look up.
  const { doc, bt } = setup('<button title=""></button>');
  const el = doc.querySelector('button');
  const stats = bt.createStats();
  const translate = bt.createTranslator(dict);

  bt.walkAndTranslate(doc.body, translate, stats);
  el.setAttribute('title', 'Adószám');          // the data arrives, observer offline
  bt.walkAndTranslate(doc.body, translate, stats);

  assert.equal(el.getAttribute('title'), 'Numéro fiscal');
});

test('a lazy shard landing mid-hover never freezes the title in one language', async () => {
  // Reproduction of the mirror defect, single language, no switch:
  //   walk (the zone holding the label has not landed: miss) → hover (_fixTitle)
  //   → prefetch lands and we re-walk → unhover (_restoreTitle).
  // _restoreTitle copies the stash back into `title`; if what sits in the stash is
  // OUR translation, the observer sees a value it does not recognise, forgets the
  // Hungarian original and adopts the translation as the original — the tooltip is
  // then stuck in that language for the page's life and the English string is
  // reported as untranslated Hungarian.
  const { doc, bt } = setup('<button title="Adószám"></button>');
  const el = doc.querySelector('button');
  const stats = bt.createStats();
  const translate = liveTranslator({});          // zone not loaded yet
  const obs = bt.installObserver(doc.body, translate, stats);

  bt.walkAndTranslate(doc.body, translate, stats);
  assert.equal(el.getAttribute('title'), 'Adószám', 'a miss leaves Hungarian in place');

  fixTitle(el);                                  // user hovers
  await settle();

  translate.use({ 'Adószám': 'Tax number' });    // prefetchAllZones lands
  bt.walkAndTranslate(doc.body, translate, stats);
  await settle();

  restoreTitle(el);                              // user moves away
  await settle();

  bt.walkAndTranslate(doc.body, translate, stats);
  assert.equal(el.getAttribute('title'), 'Tax number', 'still translatable after the cycle');

  bt.walkAndTranslate(doc.body, () => null, stats); // back to Hungarian
  assert.equal(el.getAttribute('title'), 'Adószám', 'the remembered original survived');
  assert.deepEqual(
    [...stats.uniqueMisses],
    ['Adószám'],
    'no translation of ours was ever reported as untranslated Hungarian'
  );
  obs.disconnect();
});

test('switching language mid-hover leaves the tooltip switchable, incl. back to Hungarian', async () => {
  // Same defect reached through the popup: walk EN → hover → switch to FR → unhover.
  const { doc, bt } = setup('<button title="Adószám"></button>');
  const el = doc.querySelector('button');
  const stats = bt.createStats();
  const translate = liveTranslator({ 'Adószám': 'Tax number' });
  const obs = bt.installObserver(doc.body, translate, stats);

  bt.walkAndTranslate(doc.body, translate, stats);
  assert.equal(el.getAttribute('title'), 'Tax number');

  fixTitle(el);                                  // user hovers, tooltip shows English
  await settle();

  translate.use({ 'Adószám': 'Numéro fiscal' }); // popup: EN → FR, full re-walk
  bt.walkAndTranslate(doc.body, translate, stats);
  await settle();

  restoreTitle(el);                              // user moves away
  await settle();

  bt.walkAndTranslate(doc.body, translate, stats);
  assert.equal(el.getAttribute('title'), 'Numéro fiscal', 'the switch reached the tooltip');

  bt.walkAndTranslate(doc.body, () => null, stats); // back to Hungarian
  assert.equal(el.getAttribute('title'), 'Adószám');
  // Restoring Hungarian is an always-null translator, so the Hungarian key itself
  // is legitimately a miss; what must never appear is a translation of ours.
  assert.deepEqual(
    [...stats.uniqueMisses].filter((m) => m !== 'Adószám'),
    [],
    'no foreign string entered the misses'
  );
  obs.disconnect();
});

test('keeps the Hungarian original through a full Bootstrap tooltip lifecycle', async () => {
  // _fixTitle() writes title="" — a teardown, not content. Forgetting the
  // remembered original there used to make restore-to-Hungarian impossible.
  const { doc, bt } = setup('<button title="Adószám"></button>');
  const el = doc.querySelector('button');
  const stats = bt.createStats();
  const obs = bt.installObserver(doc.body, bt.createTranslator(dict), stats);

  bt.walkAndTranslate(doc.body, bt.createTranslator(dict), stats);
  assert.equal(el.getAttribute('title'), 'Numéro fiscal');

  fixTitle(el);
  await settle();

  // Bootstrap's restoreTitle() on dispose: copy the stash back into title.
  el.setAttribute('title', el.getAttribute('data-original-title'));
  el.removeAttribute('data-original-title');
  await settle();

  bt.walkAndTranslate(doc.body, () => null, stats); // back to Hungarian
  assert.equal(el.getAttribute('title'), 'Adószám');
  obs.disconnect();
});
