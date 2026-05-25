// tests/spa-router.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadBillingoTranslator } from './load-script.js';

test('onRouteChange fires debounced with pathname on pushState + popstate', async () => {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://app.billingo.hu/n/dashboard' });
  const win = dom.window;
  // The router only touches the window passed via opts, so the sandbox needs no
  // DOM globals — just load the module and read its export.
  const bt = loadBillingoTranslator('src/spa-router.js', {});
  const seen = [];
  const teardown = bt.onRouteChange((p) => seen.push(p), { window: win, debounceMs: 5, pollMs: 1000 });

  win.history.pushState({}, '', '/n/document/create/invoice');
  win.history.pushState({}, '', '/n/bank-account/list'); // rapid -> debounced to last
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, ['/n/bank-account/list']);

  win.dispatchEvent(new win.PopStateEvent('popstate')); // same path -> deduped, no new fire
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen[seen.length - 1], '/n/bank-account/list');

  teardown(); // clear the poll interval so node:test can exit
});

test('detects a route change that bypasses pushState (content-script isolated world)', async () => {
  // A content script cannot intercept the page's own history.pushState (separate
  // JS world / Firefox Xray), so detection must not depend on the patch firing.
  // dom.reconfigure changes location WITHOUT calling our patched pushState,
  // modelling the real Vue navigation our content script can't hook.
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://app.billingo.hu/n/dashboard' });
  const win = dom.window;
  const bt = loadBillingoTranslator('src/spa-router.js', {});
  const seen = [];
  const teardown = bt.onRouteChange((p) => seen.push(p), { window: win, debounceMs: 1, pollMs: 5 });

  dom.reconfigure({ url: 'https://app.billingo.hu/n/accountant-affiliate' });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seen, ['/n/accountant-affiliate']);

  teardown();
});
