// tests/shard-loader.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBillingoTranslator } from './load-script.js';

// loadBillingoTranslator(paths, globals) evaluates the file(s) in a vm sandbox
// and returns globalThis.BillingoTranslator. shard-loader uses console.warn on
// fetch failure, so inject console; Set/Map/Promise/Object are vm intrinsics.
function setup() {
  return loadBillingoTranslator('src/shard-loader.js', { console });
}

const index = [
  { prefix: '/n/document', shard: 'documents' },
  { prefix: '/n/bank-account', shard: 'bank' },
  { prefix: '/n/bob', shard: 'bank' },
];
const shards = {
  _common: { 'Mentés': 'Save' },
  documents: { 'Számla': 'Invoice' },
  bank: { 'Bank': 'Bank' },
};

test('ensureCommon + ensureZoneForRoute merge the right shards', async () => {
  const BT = setup();
  const fetched = [];
  const fetchShard = async (lang, shard) => { fetched.push(`${lang}/${shard}`); return shards[shard]; };
  const loader = BT.createShardLoader({ index, fetchShard, lang: 'en' });
  await loader.ensureCommon();
  const added1 = await loader.ensureZoneForRoute('/n/document/create/invoice');
  assert.equal(added1, true);
  assert.equal(loader.getMerged()['Számla'], 'Invoice');
  assert.equal(loader.getMerged()['Mentés'], 'Save');
  // load-and-keep: revisiting the zone does not refetch.
  const added2 = await loader.ensureZoneForRoute('/n/document/invoice/list');
  assert.equal(added2, false);
  assert.deepEqual(fetched, ['en/_common', 'en/documents']);
});

test('unknown route adds no zone shard', async () => {
  const BT = setup();
  const fetchShard = async (lang, shard) => shards[shard];
  const loader = BT.createShardLoader({ index, fetchShard, lang: 'en' });
  await loader.ensureCommon();
  const added = await loader.ensureZoneForRoute('/n/totally-unknown');
  assert.equal(added, false);
});

test('concurrent ensureZoneForRoute fetches the shard once', async () => {
  const BT = setup();
  let calls = 0;
  const fetchShard = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return shards.bank; };
  const loader = BT.createShardLoader({ index, fetchShard, lang: 'en' });
  await Promise.all([loader.ensureZoneForRoute('/n/bob/x'), loader.ensureZoneForRoute('/n/bank-account/y')]);
  assert.equal(calls, 1);
});

test('ensureAll loads every distinct zone plus _common, exactly once', async () => {
  const BT = setup();
  const fetched = [];
  const fetchShard = async (lang, shard) => { fetched.push(shard); return shards[shard]; };
  const loader = BT.createShardLoader({ index, fetchShard, lang: 'fr' });

  assert.equal(await loader.ensureAll(), true);
  assert.deepEqual(fetched.sort(), ['_common', 'bank', 'documents']); // 'bank' listed twice in index
  assert.equal(loader.getMerged()['Számla'], 'Invoice');
  assert.equal(loader.getMerged()['Bank'], 'Bank');

  // load-and-keep: a second sweep merges nothing new and refetches nothing.
  assert.equal(await loader.ensureAll(), false);
  assert.equal(fetched.length, 3);
});

test('ensureAll keeps the zones it could load when one shard 404s', async () => {
  const BT = setup();
  const fetchShard = async (lang, shard) => {
    if (shard === 'bank') throw new Error('404');
    return shards[shard];
  };
  const loader = BT.createShardLoader({ index, fetchShard, lang: 'fr' });

  assert.equal(await loader.ensureAll(), true);
  assert.equal(loader.getMerged()['Számla'], 'Invoice');
});

test('fetch failure is swallowed (returns false, no throw)', async () => {
  const BT = setup();
  const fetchShard = async () => { throw new Error('network'); };
  const loader = BT.createShardLoader({ index, fetchShard, lang: 'en' });
  const added = await loader.ensureZoneForRoute('/n/document/x');
  assert.equal(added, false);
});
