// tests/miss-reporting.test.js
// Covers which strings count as a miss, with real fixtures from a popup export taken on
// a live inventory page: 169 of its 310 entries were amounts, identifiers, dates or lone
// punctuation. That export is the only feedback loop from usage back into the dictionary,
// and it also feeds the coverage percentage, so a rule that is too lenient buries the
// signal and understates coverage.
//
// The opposite failure matters more, which is what the second half of this file is for: a
// rule that is too aggressive silently hides strings we genuinely need to translate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBillingoTranslator } from './load-script.js';

const { isReportableMiss, createStats } = loadBillingoTranslator('src/translator.js');

// Verbatim from billingo-untranslated-v1.0.2-n-campaign-manager-list.
const NOT_TEXT = [
  '-', ',', '.', '...', '«', '»', '/', '×', '<', '>', '1', '10', '20',
  '-€0,09', '-€1 168,40', '+€2 000,00', '€-1 740,73', '€0,00',
  '0 Ft', '1 333 Ft', '2 281 356 Ft', '2.490 Ft', '100 %',
  '1 EUR = 362 Ft',
  '+33', 'D02 T380',
  '2020', '2020 - 2029', '2025. 06. 30. 09:50',
  '05341772-1...', '0534177e-c...', '...LT12 34567890 12345678',
];

// Also verbatim from that export: real UI text, or a name a human must decide about.
const REPORTABLE = [
  'Alkalmaz',
  'Szállító adatok',
  'Bevételezés dátuma',
  'Nincsenek megjeleníthető készletek!',
  'Példa Péter',
  'Példa Tanácsadó Kft.',
  'Billingo Pay',
];

test('amounts, identifiers, dates and punctuation are not misses', () => {
  // Act / Assert
  for (const text of NOT_TEXT) {
    assert.equal(isReportableMiss(text), false, `${JSON.stringify(text)} should be filtered`);
  }
});

test('real UI text is still a miss', () => {
  // Act / Assert
  for (const text of REPORTABLE) {
    assert.equal(isReportableMiss(text), true, `${JSON.stringify(text)} must be reported`);
  }
});

test('a name is still reported, because no rule separates it from UI text', () => {
  // Arrange — `Példa Péter` and `Szállító adatok` are both two Hungarian-looking
  // words. A rule that dropped one would drop the other, and hiding real UI text is the
  // worse failure, so names stay in and a human decides.
  // Act / Assert
  assert.equal(isReportableMiss('Példa Péter'), true);
  assert.equal(isReportableMiss('Szállító adatok'), true);
});

test('accent-less Hungarian is still reported', () => {
  // Arrange — capture already cannot see accent-less Hungarian, since makeHuFilter needs
  // a diacritic. If the runtime export dropped it too, the gap would close nowhere.
  // Act / Assert
  assert.equal(isReportableMiss('Alkalmaz'), true);
  assert.equal(isReportableMiss('Menu'), true);
  assert.equal(isReportableMiss('Logo'), true);
});

test('a one-letter label is text, a lone letter inside an identifier is not', () => {
  // Arrange — 'x' on a close button is real UI text. 'D02 T380' is an Eircode, and it was
  // the only string in a real 310-entry export that the plain two-letter rule discarded.
  // Act / Assert
  assert.equal(isReportableMiss('x'), true);
  assert.equal(isReportableMiss('D02 T380'), false);
  assert.equal(isReportableMiss('1'), false);
  assert.equal(isReportableMiss('-'), false);
});

test('a currency code alone is not text, but a word beside one is', () => {
  // Act / Assert
  assert.equal(isReportableMiss('1 333 Ft'), false);
  assert.equal(isReportableMiss('Összesen 1 333 Ft'), true);
});

test('a string the UI truncated is not reported', () => {
  // Arrange — the dictionary holds whole values, so an ellipsised fragment can only ever
  // miss, forever.
  // Act / Assert
  assert.equal(isReportableMiss('Számla letöltése...'), false);
  assert.equal(isReportableMiss('…letöltése'), false);
  assert.equal(isReportableMiss('Számla letöltése'), true);
});

test('emails and URLs are not reported', () => {
  // Act / Assert
  assert.equal(isReportableMiss('someone@example.invalid'), false);
  assert.equal(isReportableMiss('https://example.invalid/x'), false);
  assert.equal(isReportableMiss('www.example.invalid'), false);
});

test('empty and non-string input is never reported', () => {
  // Act / Assert
  for (const value of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(isReportableMiss(value), false, `${JSON.stringify(value)}`);
  }
});

test('recordMiss ignores unreportable strings entirely', () => {
  // Arrange
  const stats = createStats();

  // Act
  stats.recordMiss('-€1 168,40');
  stats.recordMiss('2025. 06. 30. 09:50');
  stats.recordMiss('Szállító adatok');

  // Assert — neither counted nor exported, so coverage is computed over translatable
  // text only.
  assert.equal(stats.misses, 1);
  assert.deepEqual([...stats.uniqueMisses], ['Szállító adatok']);
});

test('our own emitted output is still excluded, ahead of the new rule', () => {
  // Arrange — Bootstrap re-renders .tooltip-inner from the already-translated title, so
  // our output comes back as a fresh text node. That guard must keep working.
  const stats = createStats();
  stats.recordHit('Számla', 'Invoice');

  // Act
  stats.recordMiss('Invoice');

  // Assert
  assert.equal(stats.misses, 0);
  assert.equal(stats.uniqueMisses.size, 0);
});
