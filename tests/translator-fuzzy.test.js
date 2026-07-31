// tests/translator-fuzzy.test.js
// The fallback layers that run after an exact-match miss: whitespace
// normalisation, trailing-punctuation stripping, and pattern matching
// (Laravel-style :tokens and numeric templates).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBillingoTranslator } from './load-script.js';

const { createTranslator } = loadBillingoTranslator('src/translator.js');

// --- Layer 2: whitespace normalisation -------------------------------------

test('collapses internal whitespace runs before lookup', () => {
  const t = createTranslator({ 'Új tétel hozzáadása': 'Ajouter une ligne' });
  assert.equal(t('Új  tétel\n        hozzáadása'), 'Ajouter une ligne');
});

test('treats a non-breaking space as whitespace', () => {
  const t = createTranslator({ 'Fizetési határidő': 'Échéance' });
  assert.equal(t('Fizetési határidő'), 'Échéance');
});

// --- Layer 3: trailing punctuation -----------------------------------------

test('matches a label that the DOM renders with a trailing colon', () => {
  const t = createTranslator({ 'Adószám': 'Numéro fiscal' });
  assert.equal(t('Adószám:'), 'Numéro fiscal:');
});

test('matches a label carrying a required-field marker', () => {
  const t = createTranslator({ 'Megjegyzés': 'Remarque' });
  assert.equal(t('Megjegyzés *'), 'Remarque *');
});

test('an exact key wins over the punctuation-stripped one', () => {
  const t = createTranslator({ 'Összesen:': 'Total TTC :', 'Összesen': 'Total' });
  assert.equal(t('Összesen:'), 'Total TTC :');
});

// --- Layer 4a: named (:token) patterns --------------------------------------

test('fills a :token pattern with the rendered value', () => {
  const t = createTranslator({ ':type előtag': 'Préfixe :type' });
  assert.equal(t('Számla előtag'), 'Préfixe Számla');
});

test('translates the captured fragment when the dictionary knows it', () => {
  const t = createTranslator({
    ':type letöltése': 'Télécharger :type',
    'Számla': 'Facture',
  });
  assert.equal(t('Számla letöltése'), 'Télécharger Facture');
});

test('fills several distinct tokens', () => {
  const t = createTranslator({
    ':day nap és :hour óra': ':day jours et :hour heures',
  });
  assert.equal(t('5 nap és 3 óra'), '5 jours et 3 heures');
});

test('reorders tokens according to the translation', () => {
  const t = createTranslator({ ':a után :b': ':b avant :a' });
  assert.equal(t('alma után körte'), 'körte avant alma');
});

test('a pattern with no literal text never matches (no catch-all)', () => {
  const t = createTranslator({ ':type': 'Type :type', 'Számlák': 'Factures' });
  assert.equal(t('bármi'), null);
  assert.equal(t('Számlák'), 'Factures');
});

test('a pattern whose translation drops a token is not usable', () => {
  // Cannot rebuild the sentence: the FR side lost :number.
  const t = createTranslator({ 'Cégjegyzékszám: :number kiadva': 'Non traduit' });
  assert.equal(t('Cégjegyzékszám: 01-09-123456 kiadva'), null);
});

// --- Layer 4b: numeric patterns ---------------------------------------------

test('generalises a numeric key to any number', () => {
  const t = createTranslator({ '3 db': '3 pcs' });
  assert.equal(t('7 db'), '7 pcs');
});

test('generalises a percentage key', () => {
  const t = createTranslator({ '27% ÁFA': '27% TVA' });
  assert.equal(t('5% ÁFA'), '5% TVA');
});

test('prefers a plural source pair when several share the same shape', () => {
  const t = createTranslator({ '1 nap': '1 jour', '5 nap': '5 jours' });
  assert.equal(t('12 nap'), '12 jours');
});

test('does not build a pattern from a pure date-shaped key', () => {
  // '2026-01-01' has no lettered literal — generalising it would match every date
  // and translate it to itself.
  const t = createTranslator({ '2026-01-01': '2026-01-01' });
  assert.equal(t('2024-07-31'), null);
});

test('numbers in a key with no lettered literal do not generalise', () => {
  const t = createTranslator({ '1 / 2': '1 / 2' });
  assert.equal(t('3 / 4'), null);
});

// --- Ordering and safety -----------------------------------------------------

test('the most specific pattern wins', () => {
  const t = createTranslator({
    ':type letöltése': 'Télécharger :type',
    'Számla :type letöltése': 'Télécharger la facture :type',
  });
  assert.equal(t('Számla PDF letöltése'), 'Télécharger la facture PDF');
});

test('an empty translation is still a miss at every layer', () => {
  const t = createTranslator({ ':type előtag': '', 'Adószám': '' });
  assert.equal(t('Számla előtag'), null);
  assert.equal(t('Adószám:'), null);
});

test('inherited Object properties are never treated as translations', () => {
  const t = createTranslator({ 'Számlák': 'Factures' });
  assert.equal(t('constructor'), null);
  assert.equal(t('toString'), null);
  assert.equal(t('__proto__'), null);
});

test('the exact and punctuation layers read the dictionary live', () => {
  // The shard loader merges new zones into the same object the translator holds.
  const dict = { 'Számlák': 'Factures' };
  const t = createTranslator(dict);
  assert.equal(t('Adószám:'), null);
  Object.assign(dict, { 'Adószám': 'Numéro fiscal' });
  assert.equal(t('Adószám:'), 'Numéro fiscal:');
});

test('refresh() rebuilds the pattern index after new shards are merged', () => {
  const dict = { 'Számlák': 'Factures' };
  const t = createTranslator(dict);
  assert.equal(t('Számla letöltése'), null);   // builds the (empty) pattern index
  Object.assign(dict, { ':type letöltése': 'Télécharger :type' });
  assert.equal(t('Számla letöltése'), null);   // index still stale
  t.refresh();
  assert.equal(t('Számla letöltése'), 'Télécharger Számla');
});
