// tests/dict-counted-units.test.js
// Pins the counted-unit families against the SHIPPED dictionaries, not a synthetic one.
//
// "28 nap" was rendering untranslated on screen while "28 nap múlva" was fine: the
// dictionary held `:due_days nap múlva`, which the pattern layer generalises to any
// number, and nothing for the bare noun. That class of gap is invisible to the coverage
// metric — the catalog holds a template, and Vue injects the number at render time — so
// the only thing that catches a regression here is an assertion over real values.
//
// The ordering assertion matters most: Hungarian does not pluralise after a numeral and
// EN/FR do, so the singular is an exact key and the plural is a pattern. That only reads
// correctly because layer 1 (exact) runs before layer 5 (patterns). Swap them and every
// count silently renders "1 days".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadBillingoTranslator } from './load-script.js';

const BT = loadBillingoTranslator('src/translator.js');

const dict = (lang) => JSON.parse(
  fs.readFileSync(new URL(`../dict/${lang}.json`, import.meta.url), 'utf8'));

const translator = (lang) => BT.createTranslator(dict(lang), { lang });

// One arbitrary count that no exact key covers, so only the pattern can answer.
const N = 28;

const FAMILIES = [
  { hu: `${N} nap`, en: `${N} days`, fr: `${N} jours` },
  { hu: `${N} napos`, en: `${N}-day`, fr: `de ${N} jours` },
  { hu: `${N} napon belül`, en: `within ${N} days`, fr: `sous ${N} jours` },
  { hu: `${N} napra`, en: `for ${N} days`, fr: `pour ${N} jours` },
  { hu: `${N} munkanap`, en: `${N} working days`, fr: `${N} jours ouvrés` },
  { hu: `${N} hónap`, en: `${N} months`, fr: `${N} mois` },
  { hu: `${N} év`, en: `${N} years`, fr: `${N} ans` },
  { hu: `${N} óra`, en: `${N} hours`, fr: `${N} heures` },
  { hu: `${N} karakter`, en: `${N} characters`, fr: `${N} caractères` },
];

for (const lang of ['en', 'fr']) {
  test(`counted units resolve for an arbitrary number (${lang})`, () => {
    // Arrange
    const translate = translator(lang);

    // Act / Assert
    for (const family of FAMILIES) {
      assert.equal(translate(family.hu), family[lang], `"${family.hu}" in ${lang}`);
    }
  });
}

const SINGULARS = [
  { hu: '1 nap', en: '1 day', fr: '1 jour' },
  { hu: '1 hónap', en: '1 month', fr: '1 mois' },
  { hu: '1 év', en: '1 year', fr: '1 an' },
  { hu: '1 óra', en: '1 hour', fr: '1 heure' },
  { hu: '1 munkanap', en: '1 working day', fr: '1 jour ouvré' },
  { hu: '1 karakter', en: '1 character', fr: '1 caractère' },
];

for (const lang of ['en', 'fr']) {
  test(`an exact singular beats the plural pattern (${lang})`, () => {
    // Arrange
    const translate = translator(lang);

    // Act / Assert — the failure this guards is "1 days", which is what the pattern layer
    // produces on its own.
    for (const singular of SINGULARS) {
      assert.equal(translate(singular.hu), singular[lang], `"${singular.hu}" in ${lang}`);
    }
  });
}

test('the two competing hónap patterns agree on the plural', () => {
  // Arrange — Billingo's catalog ships both `:month hónap` and `:months hónap`. They
  // compile to the same shape, so which one wins is arbitrary; if they disagree, the
  // output flickers between "2 month" and "2 months" depending on pattern sort order.
  const en = dict('en');

  // Act
  const values = [en[':month hónap'], en[':months hónap']];

  // Assert
  for (const value of values) {
    assert.ok(value, 'a hónap placeholder key went missing');
    assert.match(value, /months$/, `${value} is not plural`);
  }
});

test('no counted-unit value leaves the placeholder unsubstituted', () => {
  // Arrange — a value whose placeholder name does not match the key's is never filled in,
  // and ships the literal ":days" to the user.
  const translate = translator('en');

  // Act / Assert
  for (const family of [...FAMILIES, ...SINGULARS]) {
    const out = translate(family.hu);
    assert.ok(!/:[a-z_]+/i.test(out ?? ''), `"${family.hu}" rendered as "${out}"`);
  }
});
