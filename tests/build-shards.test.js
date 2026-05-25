import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShards } from '../tools/build-shards.js';
import { makeHuFilter, looksLikeNoise, CHROME_STRINGS, COMMON_ZONE_THRESHOLD }
  from '../tools/lib/filters.js';

function opts(dictKeys = new Set(), dictValues = new Set()) {
  return {
    isLikelyHu: makeHuFilter(dictKeys, dictValues),
    looksLikeNoise,
    chromeStrings: CHROME_STRINGS,
    threshold: COMMON_ZONE_THRESHOLD,
  };
}

test('string vue sur 1 zone → shard de cette zone + dans le delta', () => {
  const { placement, delta } = planShards(
    { 'Tétel hozzáadása': ['documents'] }, new Set(), opts());
  assert.deepEqual([...placement.get('Tétel hozzáadása')], ['documents']);
  assert.ok(delta.has('Tétel hozzáadása'));
});

test('string vue sur ≥3 zones → _common', () => {
  const { placement } = planShards(
    { 'Mentés2': ['documents', 'partners', 'products'] }, new Set(), opts());
  assert.deepEqual([...placement.get('Mentés2')], ['_common']);
});

test('string « chrome » → _common même sur 1 zone', () => {
  const { placement } = planShards({ 'Mentés': ['documents'] }, new Set(), opts());
  assert.deepEqual([...placement.get('Mentés')], ['_common']);
});

test('clé de dico existante non ré-observée → _common, hors delta', () => {
  const { placement, delta } = planShards(
    {}, new Set(['Régi kulcs á']), opts(new Set(['Régi kulcs á'])));
  assert.deepEqual([...placement.get('Régi kulcs á')], ['_common']);
  assert.ok(!delta.has('Régi kulcs á'));
});

test('bruit exclu ; ASCII inconnu exclu', () => {
  const { placement } = planShards(
    { 'snake_case_id': ['documents'], 'Stripe': ['bank'] }, new Set(), opts());
  assert.equal(placement.has('snake_case_id'), false);
  assert.equal(placement.has('Stripe'), false);
});

test('string sur 2 zones → dupliquée dans les 2 shards', () => {
  const { placement } = planShards(
    { 'Ajánlat státusz': ['documents', 'partners'] }, new Set(), opts());
  assert.deepEqual([...placement.get('Ajánlat státusz')].sort(), ['documents', 'partners']);
});
