import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTranslations } from '../tools/bundle/merge-translations.js';

test('fills empty/missing values, never overwrites existing', () => {
  const en = { 'Számla': 'Invoice', 'Új kulcs': '' };
  const fr = { 'Számla': 'Facture', 'Új kulcs': '' };
  const t = { 'Új kulcs': { en: 'New key', fr: 'Nouvelle clé' }, 'Számla': { en: 'WRONG', fr: 'WRONG' } };
  const r = mergeTranslations(en, fr, t);
  assert.equal(en['Új kulcs'], 'New key');
  assert.equal(fr['Új kulcs'], 'Nouvelle clé');
  assert.equal(en['Számla'], 'Invoice'); // not overwritten
  assert.equal(r.filled, 1);
});
