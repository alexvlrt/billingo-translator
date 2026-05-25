import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBillingoTranslator } from './load-script.js';

const { createTranslator, createStats } = loadBillingoTranslator('src/translator.js');

test('createTranslator: returns translation when key matches exactly', () => {
  const t = createTranslator({ 'Számlák': 'Invoices' });
  assert.equal(t('Számlák'), 'Invoices');
});

test('createTranslator: returns null on miss', () => {
  const t = createTranslator({ 'Számlák': 'Invoices' });
  assert.equal(t('Beállítások'), null);
});

test('createTranslator: treats an empty translation as a miss (never blanks text)', () => {
  // build-shards seeds not-yet-translated keys with '' — the walker must leave
  // the Hungarian in place, not replace it with an empty string.
  const t = createTranslator({ 'Számlák': '' });
  assert.equal(t('Számlák'), null);
});

test('createTranslator: trims whitespace before lookup', () => {
  const t = createTranslator({ 'Számlák': 'Invoices' });
  assert.equal(t('  Számlák  '), 'Invoices');
  assert.equal(t('\tSzámlák\n'), 'Invoices');
});

test('createTranslator: returns null for empty / whitespace-only input', () => {
  const t = createTranslator({ 'Számlák': 'Invoices' });
  assert.equal(t(''), null);
  assert.equal(t('   '), null);
  assert.equal(t('\n\t'), null);
});

test('createTranslator: returns null for non-string input', () => {
  const t = createTranslator({ 'Számlák': 'Invoices' });
  assert.equal(t(null), null);
  assert.equal(t(undefined), null);
  assert.equal(t(42), null);
});

test('createStats: tracks hits and misses with dedup', () => {
  const s = createStats();
  s.recordHit('Számlák');
  s.recordHit('Számlák');
  s.recordMiss('Új ügyfél');
  s.recordMiss('Új ügyfél');
  s.recordMiss('Bezár');

  assert.equal(s.hits, 2);
  assert.equal(s.misses, 3);
  assert.deepEqual([...s.uniqueMisses].sort(), ['Bezár', 'Új ügyfél']);
});

test('createStats: reset clears all counters', () => {
  const s = createStats();
  s.recordHit('A');
  s.recordMiss('B');
  s.reset();
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 0);
  assert.equal(s.uniqueMisses.size, 0);
});
