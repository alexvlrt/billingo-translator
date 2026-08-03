// tests/dict-fiscal-safety.test.js
// The other translator tests build SYNTHETIC dictionaries, so they prove the
// layers behave — not that the SHIPPED dictionary is safe to run them against.
// That gap is how a real defect reached the tree: the key '15 000 Ft' compiled a
// numeric pattern that matched any Hungarian-formatted amount and re-joined the
// captured groups with the value's comma, so an invoice total of '1 234 567 Ft'
// rendered as '1 234,567 HUF'. This file runs the REAL dict/{en,fr}.json through
// the REAL translator and asserts the fiscal invariant directly.
//
// Billingo is wired to NAV, so a rewritten amount, identifier, date or address is
// worse than untranslated Hungarian. The rule: a translation may change words, it
// may never change digits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBillingoTranslator } from './load-script.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createTranslator } = loadBillingoTranslator('src/translator.js');

const readDict = (lang) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, `dict/${lang}.json`), 'utf8'));

const LANGS = ['en', 'fr'];
const translators = Object.fromEntries(
  LANGS.map((lang) => [lang, createTranslator(readDict(lang), { lang })]));

const digitsOf = (s) => String(s).replace(/\D+/g, '');

// A maximal "number as rendered": digit groups joined by separators.
const NUM_RUN = /\d[\d.,   ]*\d|\d/g;
const runsOf = (s) => String(s).match(NUM_RUN) || [];

// Comparing digits alone is NOT enough: '1 234 567' -> '1 234,567' keeps every
// digit while turning a thousands separator into a decimal point, which is how the
// original defect read as 1234.567 instead of 1234567. A run is safe when it is
// unchanged, or when its separators were re-grouped UNIFORMLY (every group
// separator replaced by the same character, as en-US grouping legitimately does).
// Mixed separators inside one run are the defect's signature.
function runIsSafe(before, after) {
  if (before === after) return true;
  if (digitsOf(before) !== digitsOf(after)) return false;
  const seps = (run) => run.replace(/\d/g, '');
  const outSeps = seps(after);
  if (outSeps.length !== seps(before).length) return false;   // groups moved
  return new Set(outSeps).size <= 1;                          // uniform re-grouping
}

function assertNumbersIntact(lang, input, out, what) {
  if (out === null) return; // untranslated is always safe
  const before = runsOf(input);
  const after = runsOf(out);
  assert.equal(after.length, before.length,
    `${lang}: ${what} ${JSON.stringify(input)} -> ${JSON.stringify(out)} changed how many numbers it holds`);
  before.forEach((run, i) => {
    assert.ok(runIsSafe(run, after[i]),
      `${lang}: ${what} ${JSON.stringify(input)} -> ${JSON.stringify(out)} mangled ${JSON.stringify(run)} into ${JSON.stringify(after[i])}`);
  });
}

// U+00A0 and U+202F are what Billingo actually renders inside amounts.
const NBSP = ' ';
const NNBSP = ' ';

const AMOUNTS = [
  '1 234 567 Ft', '2 000 000 Ft', '10 000 000 Ft', '32 016 000 Ft', '1 600 800 Ft',
  '1 234,56 Ft', '999 Ft', '1 000 000 000 Ft',
  `1${NBSP}234${NBSP}567 Ft`, `12${NNBSP}345 Ft`,
  '2 500 000 – 7 300 000 Ft', '0 – 500 000 Ft', '1 234 567 HUF', '1 234,56 EUR',
];

const IDENTIFIERS = [
  '12345678-1-42', '12345678-2-41', 'HU12345678',
  'HU42 1177 3016 1111 1018 0000 0000', '11773016-11110018',
  'SZ/2026/00123', '2026/1234', '27%', '5%', '18%',
];

const DATES = [
  '2026-01-01', '2026.01.01.', '2026. 01. 01.', '2026. augusztus 3.',
  '2026-01-01 - 2026-02-01', '2026.01.01 - 2026.12.31', '2026 - 2027', '10:00-15:00',
];

const ADDRESSES = [
  '1051 Budapest, Nádor utca 5.', 'Váci út 1.',
  '9021 Győr, Bécsi kapu tér 3.', 'Budapest, Rákóczi tér 2. 3. em. 4.',
  '8000 Székesfehérvár, Piac tér 4.', 'Budapest, Margit rakpart 5.',
  'Debrecen, Nagyerdei park 12.', 'Pécs, Nap utca 3.',
];

for (const lang of LANGS) {
  test(`${lang}: no translation of a rendered amount ever changes its digits`, () => {
    for (const input of AMOUNTS) {
      assertNumbersIntact(lang, input, translators[lang](input), 'amount');
    }
  });

  test(`${lang}: tax identifiers, serials and percentages keep their digits`, () => {
    for (const input of IDENTIFIERS) {
      assertNumbersIntact(lang, input, translators[lang](input), 'identifier');
    }
  });

  test(`${lang}: dates and date ranges keep their digits`, () => {
    for (const input of DATES) {
      assertNumbersIntact(lang, input, translators[lang](input), 'date');
    }
  });

  test(`${lang}: a rendered Hungarian address is left alone`, () => {
    // Public-area types (utca, út, tér, park, rakpart…) ARE dictionary keys, on
    // purpose: they appear as standalone options in the address-type picker. Lookup
    // is whole-text-node, so they must never rewrite a word inside an address.
    for (const input of ADDRESSES) {
      assert.equal(translators[lang](input), null,
        `${lang}: ${JSON.stringify(input)} must not be translated`);
    }
  });

  test(`${lang}: no shipped value is blank — a blank value silently loses coverage`, () => {
    const dict = readDict(lang);
    const blank = Object.keys(dict).filter((k) => typeof dict[k] !== 'string' || dict[k] === '');
    assert.deepEqual(blank, [], `${lang}: ${blank.length} key(s) ship with no translation`);
  });

  test(`${lang}: no numeric pattern generalises over a grouped amount`, () => {
    // Direct guard on the defect's root cause: a key whose digit runs are separated
    // only by a thousands separator is ONE number, and generalising each run turns
    // the pattern into a catch-all over every amount in the app. Such keys may
    // legitimately EXIST as exact labels; what matters is that they cannot fire on
    // somebody else's amount. Prove that on the shipped dictionary.
    const dict = readDict(lang);
    const grouped = Object.keys(dict).filter((key) => {
      const runs = [...key.matchAll(/\d+/g)];
      for (let i = 1; i < runs.length; i++) {
        const between = key.slice(runs[i - 1].index + runs[i - 1][0].length, runs[i].index);
        if (new RegExp(`^[.,\\s${NBSP}${NNBSP}]+$`).test(between)) return true;
      }
      return false;
    });
    for (const key of grouped) {
      const probe = key.replace(NUM_RUN, '9 876 543');
      assertNumbersIntact(lang, probe, translators[lang](probe), `probe for key ${JSON.stringify(key)}`);
    }
  });
}

test('the two dictionaries stay in lockstep', () => {
  assert.deepEqual(Object.keys(readDict('en')).sort(), Object.keys(readDict('fr')).sort());
});

test('no shipped key is listed in dict/_rejected.json', () => {
  // The denylist gates NEW candidates only, so a live key listed there is a
  // contradiction: someone rejected a string that is still shipping.
  const rejected = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'dict/_rejected.json'), 'utf8')).rejected;
  const en = readDict('en');
  assert.deepEqual(Object.keys(rejected).filter((k) => k in en), []);
});
