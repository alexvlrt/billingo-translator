#!/usr/bin/env node
// scripts/package.mjs
// Builds the two distributable payloads and validates them before writing.
//
//   dist/chrome/            unpacked, ready for chrome://extensions "Load unpacked"
//   dist/firefox/           unpacked, ready for about:debugging (temporary load)
//   dist/<name>-chrome-<version>.zip    Chrome Web Store upload
//   dist/<name>-firefox-<version>.zip   AMO upload -> Mozilla returns a SIGNED .xpi
//
// Zero dependencies on purpose: the ZIP writer below is ~60 lines of zlib, so
// `npm run package` works offline. `web-ext` is only needed to SIGN for Firefox,
// which stays a separate, explicitly manual step (see README).
//
// The payload is an ALLOWLIST, never "the repo minus some things": a denylist
// silently ships whatever gets added next. Everything is validated before a byte is
// written, because a package that installs and then fails at runtime is worse than
// one that refuses to build.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const LOG = '[package]';

// Firefox grants the host permissions behind `content_scripts` at INSTALL time only
// from 127 onwards; on 120-126 the content script is subject to a permission the user
// was never asked for, so the extension can install and then silently do nothing.
// Raising the floor is cheaper and more honest than shipping a runtime permission
// dance for four old versions.
const FIREFOX_MIN_VERSION = '127.0';

// --- payload ---------------------------------------------------------------

// Every file the extension needs at runtime, and nothing else. `dir` entries expand
// to their matching files; anything absent is a build error, not a warning.
const PAYLOAD = [
  { file: 'manifest.json' },
  { dir: 'src', match: /\.(js|html|css)$/ },
  { dir: 'icons', match: /\.png$/ },
  { file: 'dict/_index.json' },
  { file: 'dict/en.json' },   // monolithic fallback used by content.js loadMonolithic
  { file: 'dict/fr.json' },
  { dir: 'dict/en', match: /\.json$/ },
  { dir: 'dict/fr', match: /\.json$/ },
];

// dict/_rejected.json is build metadata (the capture denylist). The dict/*.json
// web_accessible_resources glob would serve it, so exclude it explicitly.
const EXCLUDE = new Set(['dict/_rejected.json']);

function collect() {
  const files = [];
  for (const entry of PAYLOAD) {
    if (entry.file) {
      if (!fs.existsSync(path.join(ROOT, entry.file))) {
        throw new Error(`${LOG} missing payload file: ${entry.file}`);
      }
      if (!EXCLUDE.has(entry.file)) files.push(entry.file);
      continue;
    }
    const dir = path.join(ROOT, entry.dir);
    if (!fs.existsSync(dir)) throw new Error(`${LOG} missing payload dir: ${entry.dir}`);
    const found = fs.readdirSync(dir)
      .filter((f) => entry.match.test(f))
      .map((f) => `${entry.dir}/${f}`)
      .filter((rel) => !EXCLUDE.has(rel));
    if (found.length === 0) throw new Error(`${LOG} payload dir matched nothing: ${entry.dir}`);
    files.push(...found);
  }
  return [...new Set(files)].sort();
}

// --- per-browser manifest --------------------------------------------------

export function chromeManifest(base) {
  // Chrome warns about unrecognised top-level keys; drop the Gecko block rather than
  // ship a manifest that logs a warning on every load.
  const { browser_specific_settings: _gecko, ...rest } = base;
  return rest;
}

export function firefoxManifest(base) {
  const gecko = base.browser_specific_settings?.gecko;
  if (!gecko?.id) {
    // AMO refuses an add-on with no ID, and without one every signed build would be
    // a different extension, losing the user's stored language on every update.
    throw new Error(`${LOG} browser_specific_settings.gecko.id is required for Firefox`);
  }
  // manifest.json is the single source of truth, so ASSERT the floor rather than
  // silently rewrite it — a build that quietly disagrees with the committed manifest
  // is how you ship something nobody reviewed.
  const min = Number.parseFloat(gecko.strict_min_version);
  if (!(min >= Number.parseFloat(FIREFOX_MIN_VERSION))) {
    throw new Error(`${LOG} gecko.strict_min_version is ${gecko.strict_min_version}, needs >= `
      + `${FIREFOX_MIN_VERSION}: below 127 Firefox does not grant the content_scripts host `
      + `permission at install, so the extension installs and does nothing`);
  }
  if (!gecko.data_collection_permissions) {
    // AMO already warns on this and will require it. "none" is the honest value here:
    // no network calls, no telemetry (see PRIVACY.md).
    throw new Error(`${LOG} gecko.data_collection_permissions is missing `
      + `(use { "required": ["none"] } — this extension collects nothing)`);
  }
  return base;
}

// --- validation ------------------------------------------------------------

// Checks that hold for BOTH targets, run against the exact file list that will ship.
export function validate(manifest, files, label, root = ROOT) {
  const problems = [];
  const has = (rel) => files.includes(rel);

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    problems.push(`manifest.json version ${manifest.version} != package.json ${pkg.version}`);
  }
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
    problems.push(`version ${manifest.version} is not a valid extension version`);
  }

  for (const cs of manifest.content_scripts ?? []) {
    for (const js of cs.js ?? []) if (!has(js)) problems.push(`content script not in payload: ${js}`);
  }
  const popup = manifest.action?.default_popup;
  if (popup && !has(popup)) problems.push(`popup not in payload: ${popup}`);
  for (const set of [manifest.icons, manifest.action?.default_icon]) {
    for (const icon of Object.values(set ?? {})) {
      if (!has(icon)) problems.push(`icon not in payload: ${icon}`);
    }
  }

  // The popup is loaded as a page, so whatever it references must ship too.
  if (popup && has(popup)) {
    const html = fs.readFileSync(path.join(root, popup), 'utf8');
    const dir = path.posix.dirname(popup);
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = m[1];
      if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) continue;
      const rel = path.posix.normalize(path.posix.join(dir, ref));
      if (!has(rel)) problems.push(`${popup} references a file not in payload: ${ref}`);
    }
  }

  // A web_accessible_resources pattern matching nothing means the runtime 404s on a
  // fetch it believes is allowed.
  for (const war of manifest.web_accessible_resources ?? []) {
    for (const pattern of war.resources ?? []) {
      const re = new RegExp('^' + pattern.split('*').map((s) =>
        s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
      if (!files.some((f) => re.test(f))) {
        problems.push(`web_accessible_resources pattern matches nothing: ${pattern}`);
      }
    }
  }

  // The runtime contract: src/ files are classical scripts. A stray import makes
  // Chrome refuse to evaluate the content script, and that only shows up on the
  // live site — never in the tests, which load these files through vm.
  for (const rel of files.filter((f) => f.startsWith('src/') && f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    if (/^\s*(import|export)\s/m.test(src)) problems.push(`${rel} uses ESM import/export`);
  }

  // Every shard the runtime loader may request must exist in both languages.
  if (has('dict/_index.json')) {
    const index = JSON.parse(fs.readFileSync(path.join(root, 'dict/_index.json'), 'utf8'));
    for (const { shard } of index) {
      for (const lang of ['en', 'fr']) {
        if (!has(`dict/${lang}/${shard}.json`)) {
          problems.push(`_index.json names a missing shard: ${lang}/${shard}`);
        }
      }
    }
  }
  for (const lang of ['en', 'fr']) {
    if (!has(`dict/${lang}/_common.json`)) problems.push(`missing dict/${lang}/_common.json`);
  }

  if (problems.length) {
    throw new Error(`${LOG} ${label} payload is invalid:\n  - ${problems.join('\n  - ')}`);
  }
}

// --- minimal ZIP writer ----------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Fixed 1980-01-01 timestamp so the same payload always yields the same bytes: a
// reproducible artifact is one you can diff, and store review reads the bytes.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Store instead of deflate when compression made it bigger (tiny files).
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    locals.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);              // version made by
    dir.writeUInt16LE(20, 6);              // version needed
    dir.writeUInt16LE(0, 8);               // flags
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);              // extra
    dir.writeUInt16LE(0, 32);              // comment
    dir.writeUInt16LE(0, 34);              // disk number
    dir.writeUInt16LE(0, 36);              // internal attrs
    dir.writeUInt32LE(0o644 << 16, 38);    // external attrs (unix mode)
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);                 // disk
  end.writeUInt16LE(0, 6);                 // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  // End-of-central-directory field offsets: size at 12, START OFFSET AT 16 (not 14).
  // Writing the offset at 14 clobbers the top two bytes of the size field and every
  // reader rejects the archive with "bad offset for central directory".
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                // comment length
  return Buffer.concat([...locals, centralBuf, end]);
}

// --- build -----------------------------------------------------------------

function writeTarget(target, manifest, files, logger) {
  const outDir = path.join(DIST, target);
  fs.rmSync(outDir, { recursive: true, force: true });
  const entries = [];
  for (const rel of files) {
    const data = rel === 'manifest.json'
      ? Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
      : fs.readFileSync(path.join(ROOT, rel));
    entries.push({ name: rel, data });
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  const name = `translator-for-billingo-${target}-${manifest.version}.zip`;
  const zipPath = path.join(DIST, name);
  fs.writeFileSync(zipPath, zip(entries));

  const bytes = entries.reduce((a, e) => a + e.data.length, 0);
  const zipped = fs.statSync(zipPath).size;
  logger.log(`${LOG} ${target}: ${entries.length} files, `
    + `${(bytes / 1024).toFixed(0)} KB raw -> ${(zipped / 1024).toFixed(0)} KB zipped`);
  logger.log(`${LOG}   unpacked: dist/${target}/`);
  logger.log(`${LOG}   archive : dist/${name}`);
  return { files: entries.length, zipPath, bytes, zipped };
}

export function main({ logger = console } = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const files = collect();

  const targets = { chrome: chromeManifest(base), firefox: firefoxManifest(base) };
  // Validate BOTH before writing anything, so a broken build never half-lands.
  for (const [target, manifest] of Object.entries(targets)) validate(manifest, files, target);

  fs.mkdirSync(DIST, { recursive: true });
  const result = {};
  for (const [target, manifest] of Object.entries(targets)) {
    result[target] = writeTarget(target, manifest, files, logger);
  }
  logger.log(`${LOG} version ${base.version} | Firefox floor ${FIREFOX_MIN_VERSION}`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
