import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HU_RE, looksLikeNoise, makeHuFilter, CHROME_STRINGS, COMMON_ZONE_THRESHOLD,
} from '../tools/lib/filters.js';

test('looksLikeNoise: rejette IDs, dates, identifiants, URLs', () => {
  assert.equal(looksLikeNoise('2026-05-23'), true);
  assert.equal(looksLikeNoise('camelCaseName'), true);
  assert.equal(looksLikeNoise('snake_case_id'), true);
  assert.equal(looksLikeNoise('https://x.y'), true);
  assert.equal(looksLikeNoise('1 234,56'), true);
  assert.equal(looksLikeNoise('a@b.co'), true);
});

test('looksLikeNoise: accepte du vrai texte UI', () => {
  assert.equal(looksLikeNoise('Új számla'), false);
  assert.equal(looksLikeNoise('Tétel hozzáadása'), false);
});

test('makeHuFilter: diacritique HU → true', () => {
  const isHu = makeHuFilter(new Set(), new Set());
  assert.equal(isHu('Számlák'), true);
  assert.equal(isHu('Beállítások'), true);
});

test('makeHuFilter: clé de dico connue → true même sans diacritique', () => {
  const isHu = makeHuFilter(new Set(['Bank']), new Set());
  assert.equal(isHu('Bank'), true);
});

test('makeHuFilter: valeur déjà traduite → false', () => {
  const isHu = makeHuFilter(new Set(), new Set(['Invoices']));
  assert.equal(isHu('Invoices'), false);
});

test('makeHuFilter: ASCII inconnu → false (ne pas traduire données/anglais)', () => {
  const isHu = makeHuFilter(new Set(), new Set());
  assert.equal(isHu('Stripe'), false);
});

test('constantes exportées', () => {
  assert.equal(COMMON_ZONE_THRESHOLD, 3);
  assert.ok(CHROME_STRINGS.has('Mentés'));
  assert.ok(HU_RE.test('õ') === false && HU_RE.test('ő') === true);
});
