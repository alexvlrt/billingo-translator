// tests/crx.test.js
// Guards the hand-rolled CRX3 writer. Nothing here is checkable by eye: a wrong protobuf
// field number, a flipped nibble order, or a missing length prefix all produce a
// plausible-looking .crx that Chrome refuses as corrupt — and the only place that shows
// up is a machine where the install policy then silently installs nothing.
//
// So the assertions that matter are structural (does Chrome's parser find what it looks
// for, where it looks) and cryptographic (does the signature verify over the exact bytes
// Chrome reconstructs). The decoder below is deliberately written independently of the
// encoder, so a symmetrical mistake in both cannot cancel itself out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  crx3,
  crxId,
  extensionId,
  loadPrivateKey,
  policyFiles,
  publicKeyDer,
  updatesXml,
} from '../scripts/crx.mjs';

// One 2048-bit keypair for the whole file: generation is the slow part, and every test
// here is read-only with respect to the key.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SPKI = publicKey.export({ type: 'spki', format: 'der' });

const ZIP = Buffer.from('PK\x03\x04 not a real archive, just bytes to sign', 'binary');

const HEADER_OFFSET = 12;   // magic(4) + format version(4) + header length(4)
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\0', 'binary');

// --- an independent protobuf reader ---------------------------------------

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (;;) {
    const byte = buf[cursor++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, end: cursor };
    shift += 7;
  }
}

function readField(buf, offset) {
  const tag = readVarint(buf, offset);
  const length = readVarint(buf, tag.end);
  return {
    fieldNumber: tag.value >> 3,
    wireType: tag.value & 7,
    data: buf.subarray(length.end, length.end + length.value),
    end: length.end + length.value,
  };
}

// Splits a .crx back into the pieces Chrome pulls out of it.
function parseCrx(crx) {
  const headerLength = crx.readUInt32LE(8);
  const header = crx.subarray(HEADER_OFFSET, HEADER_OFFSET + headerLength);
  const proof = readField(header, 0);
  const signedHeader = readField(header, proof.end);
  const publicKeyField = readField(proof.data, 0);
  const signatureField = readField(proof.data, publicKeyField.end);
  return {
    magic: crx.subarray(0, 4).toString('ascii'),
    formatVersion: crx.readUInt32LE(4),
    headerLength,
    proofFieldNumber: proof.fieldNumber,
    signedHeaderFieldNumber: signedHeader.fieldNumber,
    signedHeaderData: signedHeader.data,
    publicKey: publicKeyField,
    signature: signatureField,
    archive: crx.subarray(HEADER_OFFSET + headerLength),
  };
}

// --- identity --------------------------------------------------------------

test('extensionId is 32 characters in Chrome a-p alphabet', () => {
  // Act
  const id = extensionId(publicKeyDer(PEM));

  // Assert
  assert.match(id, /^[a-p]{32}$/);
});

test('extensionId shifts each nibble of the hash, and is not hex', () => {
  // Arrange — an independent derivation via the hex string, which disagrees with the
  // implementation if the high and low nibble of a byte were swapped.
  const digest = crypto.createHash('sha256').update(SPKI).digest().subarray(0, 16);
  const expected = [...digest.toString('hex')]
    .map((c) => String.fromCharCode(0x61 + Number.parseInt(c, 16)))
    .join('');

  // Act
  const id = extensionId(SPKI);

  // Assert
  assert.equal(id, expected);
  assert.notEqual(id, digest.toString('hex'));
});

test('extensionId is stable for one key and differs for another', () => {
  // Arrange
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

  // Act
  const first = extensionId(publicKeyDer(PEM));
  const again = extensionId(publicKeyDer(PEM));
  const different = extensionId(publicKeyDer(other));

  // Assert — the ID IS the identity, so instability here breaks every update forever.
  assert.equal(first, again);
  assert.notEqual(first, different);
});

// --- CRX3 structure --------------------------------------------------------

test('crx3 writes the Cr24 magic and format version 3', () => {
  // Act
  const crx = parseCrx(crx3(ZIP, PEM));

  // Assert — Chrome dropped CRX2 in v78; a 2 here installs nothing anywhere.
  assert.equal(crx.magic, 'Cr24');
  assert.equal(crx.formatVersion, 3);
});

test('crx3 appends the archive verbatim after the declared header length', () => {
  // Act
  const raw = crx3(ZIP, PEM);
  const crx = parseCrx(raw);

  // Assert — Chrome slices the zip at exactly this offset, so a header length off by one
  // byte hands the unzipper garbage.
  assert.deepEqual(crx.archive, ZIP);
  assert.equal(raw.length, HEADER_OFFSET + crx.headerLength + ZIP.length);
});

test('crx3 uses the field numbers from crx3.proto', () => {
  // Act
  const crx = parseCrx(crx3(ZIP, PEM));

  // Assert — Chrome finds the proof and the signed header BY FIELD NUMBER; a shifted
  // number is read as an unknown field and the package looks unsigned.
  assert.equal(crx.proofFieldNumber, 2);        // CrxFileHeader.sha256_with_rsa
  assert.equal(crx.signedHeaderFieldNumber, 10000); // CrxFileHeader.signed_header_data
  assert.equal(crx.publicKey.fieldNumber, 1);   // AsymmetricKeyProof.public_key
  assert.equal(crx.signature.fieldNumber, 2);   // AsymmetricKeyProof.signature
});

test('crx3 embeds the public half of the signing key', () => {
  // Act
  const crx = parseCrx(crx3(ZIP, PEM));

  // Assert — Chrome derives the installed ID from THIS copy of the key.
  assert.deepEqual(crx.publicKey.data, publicKeyDer(PEM));
});

test('the signed header carries the 16-byte crx_id derived from the key', () => {
  // Act
  const crx = parseCrx(crx3(ZIP, PEM));
  const id = readField(crx.signedHeaderData, 0);

  // Assert
  assert.equal(id.fieldNumber, 1);              // SignedData.crx_id
  assert.equal(id.data.length, 16);
  assert.deepEqual(id.data, crxId(SPKI));
});

test('the signature verifies over context, header length, signed header and archive', () => {
  // Arrange
  const crx = parseCrx(crx3(ZIP, PEM));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(crx.signedHeaderData.length, 0);

  // Act — rebuild exactly what Chrome hashes.
  const signed = Buffer.concat([SIGNATURE_CONTEXT, length, crx.signedHeaderData, ZIP]);

  // Assert — this is the one test that catches a wrong context string, a missing length
  // prefix, or the wrong RSA padding.
  assert.ok(crypto.verify('sha256', signed, {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  }, crx.signature.data), 'the CRX signature does not verify');
});

test('a tampered archive fails verification', () => {
  // Arrange — the whole point of the length prefix is that payload bytes are covered.
  const crx = parseCrx(crx3(ZIP, PEM));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(crx.signedHeaderData.length, 0);
  const tampered = Buffer.concat([SIGNATURE_CONTEXT, length, crx.signedHeaderData,
    Buffer.concat([ZIP.subarray(0, ZIP.length - 1), Buffer.from('X')])]);

  // Act / Assert
  assert.ok(!crypto.verify('sha256', tampered, {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  }, crx.signature.data));
});

// --- key validation --------------------------------------------------------

test('loadPrivateKey accepts a KeyObject so it is safe to call twice', () => {
  // Arrange — main() parses once to derive the ID, then crx3() validates the same key.
  const parsed = loadPrivateKey(PEM);

  // Act
  const again = loadPrivateKey(parsed);

  // Assert
  assert.equal(again.asymmetricKeyType, 'rsa');
});

test('loadPrivateKey rejects a non-RSA key', () => {
  // Arrange — Chrome only accepts an RSA proof in the CRX header.
  const { privateKey: ed } = crypto.generateKeyPairSync('ed25519');

  // Act / Assert
  assert.throws(() => loadPrivateKey(ed), /must be RSA/);
});

test('loadPrivateKey rejects an undersized RSA key', () => {
  // Arrange
  const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' });

  // Act / Assert
  assert.throws(() => loadPrivateKey(weak), /needs >= 2048/);
});

test('loadPrivateKey rejects the public half, naming the problem', () => {
  // Act / Assert
  assert.throws(() => loadPrivateKey(publicKey), /needs the private half/);
});

test('loadPrivateKey reports unreadable input instead of leaking a crypto error', () => {
  // Act / Assert
  assert.throws(() => loadPrivateKey('not a pem at all'), /not a readable private key/);
});

// --- update manifest -------------------------------------------------------

test('updatesXml carries the id, version and codebase Chrome polls for', () => {
  // Act
  const xml = updatesXml({
    id: 'abcdefghijklmnopabcdefghijklmnop',
    version: '1.2.3',
    codebase: 'https://example.invalid/x.crx',
  });

  // Assert
  assert.match(xml, /protocol="2\.0"/);
  assert.match(xml, /appid="abcdefghijklmnopabcdefghijklmnop"/);
  assert.match(xml, /version="1\.2\.3"/);
  assert.match(xml, /codebase="https:\/\/example\.invalid\/x\.crx"/);
});

// --- install policies ------------------------------------------------------

const POLICY_ID = 'abcdefghijklmnopabcdefghijklmnop';
const POLICY_URL = 'https://example.invalid/updates.xml';
const policyByName = (id = POLICY_ID, url = POLICY_URL) =>
  Object.fromEntries(policyFiles(id, url).map((f) => [f.name, f.data.toString('utf8')]));

test('policyFiles covers both shapes on all three platforms', () => {
  // Act
  const files = policyByName();

  // Assert
  for (const shape of ['forcelist', 'allowlist']) {
    for (const file of ['windows-chrome.reg', 'linux-chrome.json', 'macos-chrome.plist']) {
      assert.ok(`${shape}/${file}` in files, `missing ${shape}/${file}`);
    }
  }
  assert.ok('README.txt' in files);
});

test('the forcelist value pairs the ID with the update URL', () => {
  // Act
  const files = policyByName();

  // Assert — Chrome parses "<id>;<url>"; either half alone installs nothing.
  assert.match(files['forcelist/windows-chrome.reg'],
    /ExtensionInstallForcelist\]\r\n"1"="abcdefghijklmnopabcdefghijklmnop;https:\/\/example\.invalid\/updates\.xml"/);
  assert.deepEqual(JSON.parse(files['forcelist/linux-chrome.json']),
    { ExtensionInstallForcelist: [`${POLICY_ID};${POLICY_URL}`] });
  assert.match(files['forcelist/macos-chrome.plist'],
    /<string>abcdefghijklmnopabcdefghijklmnop;https:\/\/example\.invalid\/updates\.xml<\/string>/);
});

test('the allowlist value is the bare ID, with no update URL', () => {
  // Act
  const files = policyByName();

  // Assert — an allowlist entry carrying a URL is silently ignored by Chrome.
  assert.deepEqual(JSON.parse(files['allowlist/linux-chrome.json']),
    { ExtensionInstallAllowlist: [POLICY_ID] });
  for (const file of ['allowlist/windows-chrome.reg', 'allowlist/macos-chrome.plist']) {
    assert.ok(files[file].includes(POLICY_ID));
    assert.ok(!files[file].includes(POLICY_URL), `${file} leaks the update URL`);
  }
});

test('the .reg files are CRLF and pure ASCII', () => {
  // Arrange — regedit reads a BOM-less .reg as ANSI, so a non-ASCII byte corrupts it,
  // and it rejects a file whose header line is not CRLF-terminated.
  const files = policyFiles(POLICY_ID, POLICY_URL).filter((f) => f.name.endsWith('.reg'));

  // Assert
  assert.equal(files.length, 2);
  for (const { name, data } of files) {
    assert.match(data.toString('utf8'), /^Windows Registry Editor Version 5\.00\r\n/, name);
    assert.ok(data.every((byte) => byte < 0x80), `${name} contains a non-ASCII byte`);
  }
});

test('policyFiles bakes the real ID into every file, leaving no placeholder', () => {
  // Arrange — a placeholder that survives to a machine produces an extension that never
  // appears, with no error to trace.
  const id = 'ponmlkjihgfedcbaponmlkjihgfedcba';

  // Act
  const files = policyByName(id);

  // Assert
  for (const [name, body] of Object.entries(files)) {
    assert.ok(body.includes(id), `${name} does not carry the ID`);
    assert.ok(!/<id>|YOUR_|PLACEHOLDER|xxxx/i.test(body), `${name} still has a placeholder`);
  }
});

test('updatesXml escapes a codebase URL containing a query separator', () => {
  // Arrange — a raw & makes the document malformed, and Chrome reads a malformed update
  // manifest as "no update available": a silent stall rather than an error.
  const codebase = 'https://example.invalid/get?id=1&channel=beta';

  // Act
  const xml = updatesXml({ id: 'a'.repeat(32), version: '1.0.0', codebase });

  // Assert
  assert.match(xml, /channel=beta/);
  assert.ok(!/&(?!amp;|quot;|apos;|lt;|gt;)/.test(xml), 'an unescaped & is present');
});
