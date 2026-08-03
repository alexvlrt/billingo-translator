// tests/content-lang.test.js
// src/content.js has to hand the active language to createTranslator, because
// the composing layers apply the target language's typography — French sets a
// space before '! ? ; : »', the way dict/fr.json's own curated values do. There
// are two construction sites (the shard-loader path and the monolithic
// fallback); a language missing from either one produces 'Veuillez
// sélectionner!' next to the curated 'Erreur !' on the same screen.
//
// These tests drive the real wiring under jsdom and assert on the DOM text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadBillingoTranslator } from './load-script.js';

const HU = 'Kérjük válassz!';
const DICTS = {
  fr: { 'Kérjük válassz': 'Veuillez sélectionner' },
  en: { 'Kérjük válassz': 'Please select' },
};
const INDEX = [{ prefix: '/n/document', shard: 'documents' }];

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// `shards: false` makes dict/_index.json 404, which is what pushes content.js
// onto its monolithic fallback.
function setup({ lang, shards = true } = {}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head><title>t</title></head><body><h1>${HU}</h1></body></html>`,
    { url: 'https://app.billingo.hu/n/document/invoice/list' }
  );
  const win = dom.window;

  const files = { [`dict/${lang}.json`]: DICTS[lang] };
  if (shards) {
    files['dict/_index.json'] = INDEX;
    files[`dict/${lang}/_common.json`] = DICTS[lang];
    files[`dict/${lang}/documents.json`] = {};
  }
  const fetchStub = async (url) => {
    const body = files[url];
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };

  const warnings = [];
  const chrome = {
    runtime: {
      getURL: (p) => p,
      getManifest: () => ({ version: '1.0.0' }),
      onMessage: { addListener: () => {} },
    },
    storage: {
      sync: { get: async () => ({ lang }) },
      onChanged: { addListener: () => {} },
    },
  };

  // spa-router is stubbed out: the real one installs a polling interval that
  // would outlive the test.
  const seeded = { onRouteChange: () => () => {} };

  loadBillingoTranslator(
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
      console: { ...console, warn: (...args) => warnings.push(args.join(' ')) },
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (id) => clearTimeout(id),
      requestIdleCallback: (cb) => setTimeout(cb, 0),
    }
  );

  return { doc: win.document, warnings };
}

const heading = (doc) => doc.querySelector('h1').textContent;

test('the shard-loader path translates with French typography', async () => {
  const { doc } = setup({ lang: 'fr' });
  await tick();

  assert.equal(heading(doc), 'Veuillez sélectionner !');
});

test('the monolithic fallback path translates with French typography too', async () => {
  const { doc, warnings } = setup({ lang: 'fr', shards: false });
  await tick();

  // Proves we really went through the fallback branch, not the shard one.
  assert.ok(warnings.some((w) => w.includes('falling back to monolithic dict')));
  assert.equal(heading(doc), 'Veuillez sélectionner !');
});

test('English keeps the app spacing on both paths', async () => {
  const shard = setup({ lang: 'en' });
  const mono = setup({ lang: 'en', shards: false });
  await tick();

  assert.equal(heading(shard.doc), 'Please select!');
  assert.equal(heading(mono.doc), 'Please select!');
});
