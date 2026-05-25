import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZONES, buildIndex, zoneForRoute } from '../tools/zones.js';

test('zoneForRoute: éditeur de facture → documents', () => {
  assert.equal(zoneForRoute('/n/document/invoice/create'), 'documents');
  assert.equal(zoneForRoute('/n/document-block/list'), 'documents');
});

test('zoneForRoute: bob → bank', () => {
  assert.equal(zoneForRoute('/n/bob/connection-wizard/1'), 'bank');
  assert.equal(zoneForRoute('/n/bank-account/list'), 'bank');
});

test('zoneForRoute: user-invitation → users', () => {
  assert.equal(zoneForRoute('/n/user-invitation/list'), 'users');
  assert.equal(zoneForRoute('/n/user/security/tfa'), 'users');
});

test('zoneForRoute: route inconnue → null', () => {
  assert.equal(zoneForRoute('/n/some-new-page'), null);
});

test('buildIndex: trié par longueur de préfixe décroissante', () => {
  const idx = buildIndex();
  for (let i = 1; i < idx.length; i++) {
    assert.ok(idx[i - 1].prefix.length >= idx[i].prefix.length);
  }
  for (const e of idx) assert.ok(e.shard in ZONES);
});
