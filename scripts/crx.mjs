#!/usr/bin/env node
// scripts/crx.mjs
// Signs the Chrome payload with OUR OWN key and emits the update manifest Chrome polls.
//
//   dist/translator-for-billingo.crx   signed package, deliberately UNVERSIONED name
//   dist/updates.xml                   what the install policy's update_url points at
//
// This is how a Chrome extension installs PERMANENTLY without the Web Store. A .crx on
// its own is not enough — Chrome has refused a drag-and-dropped local package since v33
// — so a platform policy has to name the extension's ID. Chrome honours those policies
// on ordinary consumer installs, not only on an enrolled fleet, which is what makes this
// usable on a personal machine. Two shapes work, and `policyFiles` emits both:
//
//   ExtensionInstallAllowlist  lifts the block for this ID, then you drop the .crx in
//                              yourself. Removable, and NEVER auto-updates.
//   ExtensionInstallForcelist  Chrome fetches and installs it from updates.xml, keeps it
//                              updated, and the user cannot remove it.
//
// Forcelist is the default recommendation here only because this repo is PUBLIC, so
// `releases/latest/download/...` is anonymously fetchable. A private repo has to fall back
// to the allowlist: its release assets require auth, which Chrome's updater does not have.
//
// The extension ID is DERIVED FROM THE KEY, so the key is the identity: lose it and
// every installed copy silently stops updating, because the ID no longer matches and
// there is no way to re-issue it. Back it up outside the repo.
//
// It re-signs the zip `package.mjs` already wrote rather than rebuilding one, so the
// bytes users install are the exact bytes that were validated and would go to the Web
// Store. Zero dependencies, like the ZIP writer next door: CRX3 is a 16-byte header
// plus a three-field protobuf, which is less code than a package to emit it.
//
// Note what is NOT here: no `update_url` is added to manifest.json. The policy carries
// the update URL, and a manifest `update_url` would have to be stripped again the day
// this ships to the Web Store.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Reuse the packager's ZIP writer rather than a second one: the policy bundle is the
// only other archive we produce, and one writer means one place where a format bug lives.
import { zip } from './package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const LOG = '[crx]';

const CRX_MAGIC = Buffer.from('Cr24', 'ascii');
// Chrome removed CRX2 in v78, so there is no older format worth offering as a fallback.
const CRX_VERSION = 3;
// The signed payload carries this prefix so a signature cannot be replayed in another
// context. The trailing NUL is part of the string, not a terminator.
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\0', 'binary');
const CRX_ID_BYTES = 16;
const MIN_RSA_MODULUS_BITS = 2048;

// `latest/download` and an unversioned filename keep this URL valid for every future
// release, so the policy is written once and never revisited. updates.xml itself IS
// regenerated per release: the version inside it is what triggers the update.
const RELEASE_DOWNLOAD_BASE =
  'https://github.com/alexvlrt/billingo-translator/releases/latest/download';
const CRX_NAME = 'translator-for-billingo.crx';
const UPDATES_NAME = 'updates.xml';
const POLICY_NAME = 'translator-for-billingo-policy.zip';

// --- just enough protobuf --------------------------------------------------

// Field numbers from Chromium's components/crx_file/crx3.proto. They are wire-format
// identities: changing one produces a package Chrome rejects as corrupt.
const FIELD_SHA256_WITH_RSA = 2;        // CrxFileHeader.sha256_with_rsa
const FIELD_SIGNED_HEADER_DATA = 10000; // CrxFileHeader.signed_header_data
const FIELD_PUBLIC_KEY = 1;             // AsymmetricKeyProof.public_key
const FIELD_SIGNATURE = 2;              // AsymmetricKeyProof.signature
const FIELD_CRX_ID = 1;                 // SignedData.crx_id

const WIRE_TYPE_LENGTH_DELIMITED = 2;

function varint(value) {
  const bytes = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

// Every field we emit is length-delimited (bytes or a nested message), so one encoder
// covers the whole format: varint tag, varint length, payload.
function field(fieldNumber, data) {
  return Buffer.concat([
    varint((fieldNumber << 3) | WIRE_TYPE_LENGTH_DELIMITED),
    varint(data.length),
    data,
  ]);
}

function u32le(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

// --- identity --------------------------------------------------------------

export function publicKeyDer(privateKey) {
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
}

export function crxId(spkiDer) {
  return crypto.createHash('sha256').update(spkiDer).digest().subarray(0, CRX_ID_BYTES);
}

// Chrome renders the ID in its own base16 alphabet where 'a' is 0, so it looks like hex
// but is not: `toString('hex')` gives a plausible-looking string that matches nothing.
export function extensionId(spkiDer) {
  return [...crxId(spkiDer)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode(0x61 + nibble))
    .join('');
}

// Reject at the boundary: Chrome only accepts an RSA proof here, and an undersized key
// produces a .crx that installs today and is refused after some future hardening.
// Accepts a PEM or an already-parsed KeyObject so it is safe to call twice: `main`
// parses once to derive the ID, then hands the same key to `crx3`, which validates its
// own input rather than trusting the caller. `createPrivateKey` rejects a KeyObject.
export function loadPrivateKey(source) {
  let key;
  if (source instanceof crypto.KeyObject) {
    key = source;
  } else {
    try {
      key = crypto.createPrivateKey(source);
    } catch (err) {
      throw new Error(`${LOG} the signing key is not a readable private key: ${err.message}`);
    }
  }
  if (key.type !== 'private') {
    throw new Error(`${LOG} got a ${key.type} key — signing needs the private half`);
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`${LOG} the signing key is ${key.asymmetricKeyType}, but a CRX proof `
      + `must be RSA — regenerate with: openssl genrsa -out crx-key.pem 2048`);
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_MODULUS_BITS) {
    throw new Error(`${LOG} the signing key is ${bits} bits, needs >= ${MIN_RSA_MODULUS_BITS}`);
  }
  return key;
}

// --- CRX3 ------------------------------------------------------------------

export function crx3(zipData, privateKey) {
  const key = loadPrivateKey(privateKey);
  const spki = publicKeyDer(key);
  const signedHeaderData = field(FIELD_CRX_ID, crxId(spki));

  // The signature covers the context, the LENGTH of the signed header, the header, and
  // the archive. The length is what pins the boundary between header and payload: drop
  // it and bytes can be moved across that boundary with the signature still valid.
  const signed = Buffer.concat([
    SIGNATURE_CONTEXT,
    u32le(signedHeaderData.length),
    signedHeaderData,
    zipData,
  ]);
  const signature = crypto.sign('sha256', signed, {
    key,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });

  const proof = Buffer.concat([
    field(FIELD_PUBLIC_KEY, spki),
    field(FIELD_SIGNATURE, signature),
  ]);
  const header = Buffer.concat([
    field(FIELD_SHA256_WITH_RSA, proof),
    field(FIELD_SIGNED_HEADER_DATA, signedHeaderData),
  ]);

  return Buffer.concat([CRX_MAGIC, u32le(CRX_VERSION), u32le(header.length), header, zipData]);
}

// --- update manifest -------------------------------------------------------

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

// Omaha's "gupdate" protocol 2.0 is the only dialect Chrome's extension updater speaks;
// a well-formed document in any other schema is read as "no update available".
export function updatesXml({ id, version, codebase }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${escapeXml(id)}">
    <updatecheck codebase="${escapeXml(codebase)}" version="${escapeXml(version)}" />
  </app>
</gupdate>
`;
}

// --- install policies ------------------------------------------------------

// The real ID is baked in at build time. A policy file shipped with a placeholder ID is
// a policy file someone deploys with the placeholder still in it, and the symptom is an
// extension that simply never appears — no error anywhere.
//
// Keep every byte here ASCII: regedit reads a .reg with no BOM as ANSI, so an accented
// comment corrupts the file it is trying to explain.
export function policyFiles(id, updateUrl) {
  const reg = (policy, value) => 'Windows Registry Editor Version 5.00\r\n\r\n'
    + `; Translator for Billingo - ${policy}\r\n`
    + `[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\\${policy}]\r\n`
    + `"1"="${value}"\r\n`;
  const json = (policy, value) => JSON.stringify({ [policy]: [value] }, null, 2) + '\n';
  const plist = (policy, value) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>${policy}</key>
  <array>
    <string>${escapeXml(value)}</string>
  </array>
</dict>
</plist>
`;

  // Forcelist takes "<id>;<update manifest url>"; allowlist takes the bare ID.
  const shapes = [
    { name: 'forcelist', policy: 'ExtensionInstallForcelist', value: `${id};${updateUrl}` },
    { name: 'allowlist', policy: 'ExtensionInstallAllowlist', value: id },
  ];
  const files = shapes.flatMap(({ name, policy, value }) => [
    { name: `${name}/windows-chrome.reg`, data: Buffer.from(reg(policy, value), 'ascii') },
    { name: `${name}/linux-chrome.json`, data: Buffer.from(json(policy, value), 'utf8') },
    { name: `${name}/macos-chrome.plist`, data: Buffer.from(plist(policy, value), 'utf8') },
  ]);
  return [{ name: 'README.txt', data: Buffer.from(policyReadme(id), 'utf8') }, ...files];
}

function policyReadme(id) {
  return `Translator for Billingo — installing on Chrome without the Web Store

Extension ID: ${id}

Chrome refuses a .crx that no policy names, so pick ONE of the two folders below and
deploy it once per machine (admin rights). Then restart the browser and check
chrome://policy — the policy must be listed there, or nothing else will work.

  forcelist/  Chrome downloads and installs the extension itself, keeps it updated, and
              the user cannot remove it. Recommended.
  allowlist/  Only lifts the block for this ID. You then install the .crx by hand from
              the release page, and it NEVER auto-updates.

Windows   double-click windows-chrome.reg, or: reg import windows-chrome.reg
          For Edge, replace Google\\Chrome with Microsoft\\Edge in the key path.
Linux     sudo cp linux-chrome.json /etc/opt/chrome/policies/managed/
          Chromium: /etc/chromium/policies/managed/   Edge: /etc/opt/edge/policies/managed/
macOS     install macos-chrome.plist as a configuration profile.

This is an unofficial, unaffiliated tool. It makes no network requests and collects
nothing — see PRIVACY.md.
`;
}

// --- build -----------------------------------------------------------------

// The key never reaches a file or a log line: it arrives in the environment (a GitHub
// secret) or as a path we read and drop. `--key` exists for local one-off builds.
function readKey({ env, argv }) {
  const flag = argv.indexOf('--key');
  if (flag !== -1) {
    const keyPath = argv[flag + 1];
    if (!keyPath) throw new Error(`${LOG} --key needs a path to a PEM file`);
    return fs.readFileSync(keyPath, 'utf8');
  }
  const inline = env.CRX_PRIVATE_KEY;
  if (!inline) {
    throw new Error(`${LOG} no signing key: set CRX_PRIVATE_KEY or pass --key <file.pem>.\n`
      + `${LOG} generate one with: openssl genrsa -out crx-key.pem 2048  (keep it OUT of the repo)`);
  }
  return inline;
}

export function main({ logger = console, env = process.env, argv = process.argv } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const zipPath = path.join(DIST, `translator-for-billingo-chrome-${manifest.version}.zip`);
  if (!fs.existsSync(zipPath)) {
    throw new Error(`${LOG} ${path.relative(ROOT, zipPath)} is missing — `
      + `run \`npm run package\` first`);
  }

  const key = loadPrivateKey(readKey({ env, argv }));
  const id = extensionId(publicKeyDer(key));
  const crx = crx3(fs.readFileSync(zipPath), key);

  const updateUrl = `${RELEASE_DOWNLOAD_BASE}/${UPDATES_NAME}`;
  const crxPath = path.join(DIST, CRX_NAME);
  const updatesPath = path.join(DIST, UPDATES_NAME);
  const policyPath = path.join(DIST, POLICY_NAME);
  fs.writeFileSync(crxPath, crx);
  fs.writeFileSync(updatesPath, updatesXml({
    id,
    version: manifest.version,
    codebase: `${RELEASE_DOWNLOAD_BASE}/${CRX_NAME}`,
  }));
  fs.writeFileSync(policyPath, zip(policyFiles(id, updateUrl)));

  logger.log(`${LOG} ${CRX_NAME}: ${(crx.length / 1024).toFixed(0)} KB, version ${manifest.version}`);
  logger.log(`${LOG} extension id: ${id}`);
  logger.log(`${LOG} forcelist   : ${id};${updateUrl}`);
  logger.log(`${LOG} policies    : dist/${POLICY_NAME}`);
  return { id, crxPath, updatesPath, policyPath, bytes: crx.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
