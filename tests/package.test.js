// tests/package.test.js
// Guards the packaging step. Two things here are worth a test:
//   1. the per-browser manifest rules, because getting them wrong produces a package
//      that installs and then silently does nothing (the Firefox 127 host-permission
//      cliff) or that AMO refuses to sign;
//   2. the hand-rolled ZIP writer, because its first version wrote the central
//      directory offset at byte 14 instead of 16, which clobbered the size field and
//      every reader rejected the archive. A structural assertion catches that class.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { chromeManifest, firefoxManifest, validate, zip } from '../scripts/package.mjs';

// Read from package.json so BASE cannot drift out of sync on the next version bump —
// which is exactly what happened to the hardcoded "v1.1" in the popup footer.
const PKG_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const BASE = {
  manifest_version: 3,
  name: 'Translator for Billingo',
  version: PKG_VERSION,
  browser_specific_settings: {
    gecko: {
      id: 'translator-for-billingo@example.invalid',
      strict_min_version: '127.0',
      data_collection_permissions: { required: ['none'] },
    },
  },
  permissions: ['storage'],
  host_permissions: ['https://app.billingo.hu/*'],
  action: { default_popup: 'src/popup.html', default_icon: { 16: 'icons/icon16.png' } },
  icons: { 16: 'icons/icon16.png' },
  content_scripts: [{ matches: ['https://app.billingo.hu/*'], js: ['src/translator.js'] }],
  web_accessible_resources: [{ resources: ['dict/*.json'], matches: ['https://app.billingo.hu/*'] }],
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// --- per-browser manifests -------------------------------------------------

test('chrome: the Gecko block is dropped', () => {
  const out = chromeManifest(BASE);
  assert.equal('browser_specific_settings' in out, false);
  assert.equal(out.manifest_version, 3);
  assert.deepEqual(out.permissions, ['storage']);
  assert.equal('browser_specific_settings' in BASE, true, 'the input must not be mutated');
});

test('firefox: a valid manifest passes through untouched', () => {
  assert.deepEqual(firefoxManifest(BASE), BASE);
});

test('firefox: a missing add-on id is refused', () => {
  const bad = clone(BASE);
  delete bad.browser_specific_settings.gecko.id;
  assert.throws(() => firefoxManifest(bad), /gecko\.id is required/);
});

test('firefox: a strict_min_version below 127 is refused', () => {
  // Below 127, Firefox does not grant the content_scripts host permission at install,
  // so the add-on installs and translates nothing. Failing the build is the only way
  // that never reaches a user.
  const bad = clone(BASE);
  bad.browser_specific_settings.gecko.strict_min_version = '120.0';
  assert.throws(() => firefoxManifest(bad), /needs >= 127/);
});

test('firefox: a missing data_collection_permissions is refused', () => {
  const bad = clone(BASE);
  delete bad.browser_specific_settings.gecko.data_collection_permissions;
  assert.throws(() => firefoxManifest(bad), /data_collection_permissions/);
});

// --- payload validation ----------------------------------------------------

const FILES = [
  'manifest.json', 'src/translator.js', 'src/popup.html', 'src/popup.js', 'src/popup.css',
  'icons/icon16.png', 'dict/_index.json', 'dict/en.json', 'dict/fr.json',
  'dict/en/_common.json', 'dict/fr/_common.json',
];

test('validate: a content script missing from the payload is caught', () => {
  const m = clone(BASE);
  m.content_scripts[0].js.push('src/nope.js');
  assert.throws(() => validate(m, FILES, 'test'), /content script not in payload: src\/nope\.js/);
});

test('validate: an icon missing from the payload is caught', () => {
  const m = clone(BASE);
  m.icons = { 128: 'icons/icon128.png' };
  assert.throws(() => validate(m, FILES, 'test'), /icon not in payload/);
});

test('validate: a web_accessible_resources pattern matching nothing is caught', () => {
  // A pattern that matches nothing means the runtime 404s on a fetch it believes is
  // permitted — exactly the failure the shard loader cannot report to the user.
  const m = clone(BASE);
  m.web_accessible_resources[0].resources = ['assets/*.png'];
  assert.throws(() => validate(m, FILES, 'test'), /matches nothing: assets\/\*\.png/);
});

test('validate: a version mismatch with package.json is caught', () => {
  const m = clone(BASE);
  m.version = '9.9.9';
  assert.throws(() => validate(m, FILES, 'test'), /version 9\.9\.9 != package\.json/);
});

test('validate: a shard named by _index.json but absent is caught', () => {
  // FILES deliberately holds only _common, while the real dict/_index.json names
  // every zone shard.
  assert.throws(() => validate(clone(BASE), FILES, 'test'), /_index\.json names a missing shard/);
});

test('validate: the real payload of the repo passes for both targets', () => {
  // Sanity anchor: the shipped manifest plus a payload list built the way the script
  // builds it must validate, or `npm run package` is broken.
  const url = (p) => new URL(p, import.meta.url);
  const real = JSON.parse(fs.readFileSync(url('../manifest.json'), 'utf8'));
  const files = [
    'manifest.json',
    ...fs.readdirSync(url('../src')).map((f) => `src/${f}`),
    ...fs.readdirSync(url('../icons')).filter((f) => f.endsWith('.png')).map((f) => `icons/${f}`),
    'dict/_index.json', 'dict/en.json', 'dict/fr.json',
    ...fs.readdirSync(url('../dict/en')).map((f) => `dict/en/${f}`),
    ...fs.readdirSync(url('../dict/fr')).map((f) => `dict/fr/${f}`),
  ];
  validate(firefoxManifest(real), files, 'firefox');
  validate(chromeManifest(real), files, 'chrome');
});

// --- ZIP writer ------------------------------------------------------------

// Reads the end-of-central-directory record the way a real unzip does, so a misplaced
// field fails here instead of at store-upload time.
function readEocd(buf) {
  const at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(at > 0, 'no end-of-central-directory record');
  return {
    at,
    records: buf.readUInt16LE(at + 10),
    centralSize: buf.readUInt32LE(at + 12),
    centralOffset: buf.readUInt32LE(at + 16),
  };
}

test('zip: the central directory is located where readers expect it', () => {
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{"manifest_version":3}\n') },
    { name: 'src/a.js', data: Buffer.from('x'.repeat(5000)) },
  ];
  const buf = zip(entries);
  const eocd = readEocd(buf);

  assert.equal(eocd.records, entries.length);
  // The three sizes must tile the file exactly; the original bug broke this.
  assert.equal(eocd.centralOffset + eocd.centralSize + 22, buf.length);
  assert.equal(buf.readUInt32LE(eocd.centralOffset), 0x02014b50, 'central header signature');
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'first local header signature');
});

test('zip: entries round-trip byte for byte', () => {
  const payload = Buffer.from('Számla / facture — ' + 'á'.repeat(2000), 'utf8');
  const buf = zip([{ name: 'dict/en.json', data: payload }]);

  const nameLen = buf.readUInt16LE(26);
  const compSize = buf.readUInt32LE(18);
  const method = buf.readUInt16LE(8);
  const body = buf.subarray(30 + nameLen, 30 + nameLen + compSize);
  const out = method === 8 ? zlib.inflateRawSync(body) : body;

  assert.equal(buf.subarray(30, 30 + nameLen).toString('utf8'), 'dict/en.json');
  assert.deepEqual(out, payload);
  assert.equal(buf.readUInt32LE(22), payload.length, 'uncompressed size');
});

test('zip: a file that deflate cannot shrink is stored, not grown', () => {
  const data = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256));
  const buf = zip([{ name: 'icons/icon16.png', data }]);
  assert.equal(buf.readUInt16LE(8), 0, 'method must be 0 (stored)');
  const nameLen = buf.readUInt16LE(26);
  assert.deepEqual(buf.subarray(30 + nameLen, 30 + nameLen + data.length), data);
});

test('zip: the same payload always produces the same bytes', () => {
  // Fixed timestamps: a reproducible artifact is one you can diff before uploading.
  const entries = [{ name: 'a.txt', data: Buffer.from('hello') }];
  assert.deepEqual(zip(entries), zip(entries));
});
