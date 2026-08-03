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

test('zoneForRoute: claim-management → claimmanagement', () => {
  assert.equal(zoneForRoute('/n/claim-management/documents'), 'claimmanagement');
  assert.equal(zoneForRoute('/n/claim-management/wizard'), 'claimmanagement');
  // Les voisins en /n/c… ne doivent pas l'absorber, ni être absorbés par elle.
  assert.equal(zoneForRoute('/n/campaign-manager/list'), 'marketing');
  assert.equal(zoneForRoute('/n/ceginfo/search'), 'ceginfo');
});

test('zoneForRoute: /n/auth → auth, mais pas le login v3 hors /n', () => {
  assert.equal(zoneForRoute('/n/auth/registration'), 'auth');
  assert.equal(zoneForRoute('/n/auth/password-reset/success'), 'auth');
  assert.equal(zoneForRoute('/n/auth/otp'), 'auth');
  // Le login public est servi par l'ancien front (pas de préfixe /n) : aucune zone,
  // il reste couvert par _common.
  assert.equal(zoneForRoute('/auth/login'), null);
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

// Le tri longest-first n'a de valeur que s'il empêche réellement l'ombrage : un
// préfixe court (/n/organization) ne doit jamais voler une route couverte par un
// préfixe plus long (/n/organization-wizard). Ce test vaut pour toute paire, donc
// pour toute zone ajoutée plus tard.
test('buildIndex: aucun préfixe n’est masqué par un préfixe plus court', () => {
  const idx = buildIndex();
  const byPrefix = new Map(idx.map((e) => [e.prefix, e.shard]));
  for (const [prefix, shard] of byPrefix) {
    assert.equal(zoneForRoute(prefix, idx), shard, `${prefix} masqué`);
    assert.equal(zoneForRoute(`${prefix}/list`, idx), shard, `${prefix}/list masqué`);
  }
});

test('buildIndex: un même préfixe n’est déclaré que dans une seule zone', () => {
  const idx = buildIndex();
  const seen = new Map();
  for (const { prefix, shard } of idx) {
    assert.equal(seen.has(prefix), false, `préfixe dupliqué : ${prefix} (${seen.get(prefix)} / ${shard})`);
    seen.set(prefix, shard);
  }
});
