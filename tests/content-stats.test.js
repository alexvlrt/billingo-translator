// tests/content-stats.test.js
// Covers the getStats payload shaping in src/content.js (buildStatsPayload) and
// the message handler that uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBillingoTranslator } from './load-script.js';

// The cap is a private constant of content.js; this mirrors it. If it changes
// there, this must change too — it is the contract the popup export relies on.
const MISS_EXPORT_CAP = 2000;

// content.js cannot simply be loaded: it reads chrome.* and the DOM at
// evaluation time. The sandbox gets the smallest stubs that let the file
// evaluate, and api.storage.sync.get returns a promise that never settles, so
// the init path parks before it can fetch a dictionary or walk anything —
// leaving the pure payload helper and the message listener under test.
function loadContent({ version = '9.9.9', pathname = '/n/dashboard' } = {}) {
  const messageListeners = [];
  const chrome = {
    runtime: {
      getURL: (path) => path,
      getManifest: () => ({ version }),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
    storage: {
      sync: { get: () => new Promise(() => {}) }, // never settles: parks init
      onChanged: { addListener: () => {} },
    },
  };
  // translator.js first: content.js destructures createStats from it at load.
  const bt = loadBillingoTranslator(['src/translator.js', 'src/content.js'], {
    chrome,
    console,
    document: { documentElement: { getAttribute: () => null } },
    location: { pathname },
  });
  return { bt, messageListeners };
}

const statsWith = (misses, hits = 0) => ({
  hits,
  misses: misses.length,
  uniqueMisses: new Set(misses),
});

test('payload keeps the legacy field names and adds path, version and counts', () => {
  // Arrange
  const { bt } = loadContent();
  const stats = statsWith(['Számlák', 'Partnerek'], 17);

  // Act
  const payload = bt.buildStatsPayload({
    lang: 'fr', stats, pathname: '/n/document/invoice/list', version: '1.0.0',
  });

  // Assert — the pre-export contract, unchanged.
  assert.equal(payload.ok, true);
  assert.equal(payload.lang, 'fr');
  assert.equal(payload.hits, 17);
  assert.equal(payload.misses, 2);
  assert.deepEqual([...payload.uniqueMisses], ['Számlák', 'Partnerek']);
  // Additive fields: a harvested list has to say where it came from.
  assert.equal(payload.pathname, '/n/document/invoice/list');
  assert.equal(payload.version, '1.0.0');
  assert.equal(payload.uniqueMissCount, 2);
  assert.equal(payload.truncated, false);
});

test('uniqueMisses is emitted as an Array, never the live Set', () => {
  // Chrome serialises extension messages as JSON: a Set would arrive as {}.
  const { bt } = loadContent();
  const stats = statsWith(['Mentés']);

  const payload = bt.buildStatsPayload({ lang: 'en', stats });

  assert.ok(Array.isArray(payload.uniqueMisses));
  payload.uniqueMisses.push('injected'); // must not reach the live stats
  assert.equal(stats.uniqueMisses.size, 1);
});

test('empty misses yield an empty array and no truncation', () => {
  const { bt } = loadContent();

  const payload = bt.buildStatsPayload({ lang: 'hu', stats: statsWith([]) });

  assert.deepEqual([...payload.uniqueMisses], []);
  assert.equal(payload.uniqueMissCount, 0);
  assert.equal(payload.truncated, false);
});

test('a missing or malformed stats object degrades to zeroes, not NaN', () => {
  const { bt } = loadContent();

  const payload = bt.buildStatsPayload({ lang: 'en' });

  assert.equal(payload.hits, 0);
  assert.equal(payload.misses, 0);
  assert.deepEqual([...payload.uniqueMisses], []);
  assert.equal(payload.truncated, false);
});

test('the miss list is capped at MISS_EXPORT_CAP and flagged truncated', () => {
  // Arrange: one more unique miss than the cap allows.
  const { bt } = loadContent();
  const many = Array.from({ length: MISS_EXPORT_CAP + 1 }, (_, i) => `hu-${i}`);

  // Act
  const payload = bt.buildStatsPayload({ lang: 'en', stats: statsWith(many) });

  // Assert
  assert.equal(payload.uniqueMisses.length, MISS_EXPORT_CAP);
  assert.equal(payload.uniqueMisses[0], 'hu-0');
  assert.equal(payload.truncated, true);
  assert.equal(payload.uniqueMissCount, MISS_EXPORT_CAP + 1); // total before the cap
  assert.equal(payload.misses, MISS_EXPORT_CAP + 1);          // meaning unchanged
});

test('a list exactly at the cap is complete, not truncated', () => {
  const { bt } = loadContent();
  const exact = ['a', 'b', 'c'];

  const payload = bt.buildStatsPayload({ lang: 'en', stats: statsWith(exact), cap: 3 });

  assert.deepEqual([...payload.uniqueMisses], exact);
  assert.equal(payload.truncated, false);
});

test('a garbage cap falls back to the default instead of emptying the list', () => {
  // slice(0, NaN) === [] would read as "nothing to harvest" — a silent data loss.
  const { bt } = loadContent();
  const stats = statsWith(['Számlák', 'Partnerek']);

  for (const cap of [NaN, undefined, -1, 'lots', null]) {
    const payload = bt.buildStatsPayload({ lang: 'en', stats, cap });
    assert.equal(payload.uniqueMisses.length, 2, `cap=${String(cap)}`);
    assert.equal(payload.truncated, false, `cap=${String(cap)}`);
  }
});

test('the getStats message answers with the live path and the manifest version', () => {
  // Arrange: the real listener content.js registered on api.runtime.onMessage.
  const { messageListeners } = loadContent({ version: '2.3.4', pathname: '/n/partner/list' });
  assert.equal(messageListeners.length, 1);
  let payload = null;

  // Act
  const isAsync = messageListeners[0]({ type: 'getStats' }, null, (res) => { payload = res; });

  // Assert — answered synchronously (the listener must return false).
  assert.equal(isAsync, false);
  assert.equal(payload.ok, true);
  assert.equal(payload.lang, 'hu'); // init parked, so still the default
  assert.equal(payload.pathname, '/n/partner/list');
  assert.equal(payload.version, '2.3.4');
  assert.deepEqual([...payload.uniqueMisses], []);
  assert.equal(payload.truncated, false);
});

test('an unknown message type is ignored', () => {
  const { messageListeners } = loadContent();
  let called = false;

  const isAsync = messageListeners[0]({ type: 'nope' }, null, () => { called = true; });

  assert.equal(isAsync, false);
  assert.equal(called, false);
});
