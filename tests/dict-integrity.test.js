// tests/dict-integrity.test.js
// Guards on the shipped dictionary itself. These are the cheap checks that would
// have caught the `/n/organization` → missing-shard 404: the runtime fetches
// whatever _index.json names, and a miss there silently costs a whole zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['en', 'fr'];

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const index = readJson('dict/_index.json');
const shardNames = [...new Set(index.map((e) => e.shard))];

test('every shard named by _index.json exists in both languages', () => {
  for (const lang of LANGS) {
    for (const shard of [...shardNames, '_common']) {
      const rel = `dict/${lang}/${shard}.json`;
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
    }
  }
});

test('_index.json is sorted longest-prefix-first', () => {
  const lengths = index.map((e) => e.prefix.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a));
});

test('every shard file is reachable from a route prefix or is _common', () => {
  const reachable = new Set([...shardNames, '_common']);
  for (const file of fs.readdirSync(path.join(ROOT, 'dict/en'))) {
    const shard = file.replace(/\.json$/, '');
    assert.ok(reachable.has(shard), `dict/en/${file} is never loaded by any route`);
  }
});

test('EN and FR shards hold exactly the same keys', () => {
  for (const shard of [...shardNames, '_common']) {
    const en = Object.keys(readJson(`dict/en/${shard}.json`)).sort();
    const fr = Object.keys(readJson(`dict/fr/${shard}.json`)).sort();
    assert.deepEqual(en, fr, `key drift between dict/en/${shard}.json and dict/fr/${shard}.json`);
  }
});

test('no shard key is blank or untrimmed', () => {
  for (const lang of LANGS) {
    for (const shard of [...shardNames, '_common']) {
      for (const key of Object.keys(readJson(`dict/${lang}/${shard}.json`))) {
        assert.notEqual(key.trim(), '', `blank key in dict/${lang}/${shard}.json`);
        assert.equal(key, key.trim(), `untrimmed key in dict/${lang}/${shard}.json: ${JSON.stringify(key)}`);
      }
    }
  }
});
