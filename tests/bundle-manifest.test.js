import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChunkManifest, scriptSrcUrls } from '../tools/bundle/manifest.js';

test('parseChunkManifest extracts id->hash from the runtime map', () => {
  const runtime = 'x.miniCssF=e=>{};x.u=e=>"nuxt/"+{0:"1a077e6",1:"6229229",1252:"39896bd"}[e]+".js";';
  const map = parseChunkManifest(runtime);
  assert.equal(map[0], '1a077e6');
  assert.equal(map[1], '6229229');
  assert.equal(map[1252], '39896bd');
});

test('parseChunkManifest skips non-string edge entries without aborting', () => {
  // Real maps have a few entries whose value is not a quoted hash (webpack edge
  // chunks). Those must be skipped, not abort extraction of the rest.
  const runtime = 'u=e=>"nuxt/"+{0:"1a077e6",5:0,6:"6229229",7:n,1252:"39896bd"}[e]+".js"';
  const map = parseChunkManifest(runtime);
  assert.equal(map[0], '1a077e6');
  assert.equal(map[6], '6229229');
  assert.equal(map[1252], '39896bd');
  assert.equal(map[5], undefined); // numeric value skipped
  assert.equal(map[7], undefined); // identifier value skipped
});

test('scriptSrcUrls returns all <script src> .js urls', () => {
  const html = '<script src="https://assets.billingo.hu/nuxt/2f39f92.js"></script>'
    + '<script src="https://assets.billingo.hu/nuxt/b19efaa.js"></script><link href="x.css">';
  assert.deepEqual(scriptSrcUrls(html), [
    'https://assets.billingo.hu/nuxt/2f39f92.js',
    'https://assets.billingo.hu/nuxt/b19efaa.js',
  ]);
});
