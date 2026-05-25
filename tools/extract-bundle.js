#!/usr/bin/env node
// tools/extract-bundle.js
// Discover the Nuxt bundle (auth once), fetch all chunks (hash-cached), extract
// Hungarian strings, map them to zones, and write artifacts for build-shards.
//
// Usage: node tools/extract-bundle.js <cookie-jar.txt>
//   Reads cookies only to fetch the authenticated /n/dashboard shell (to discover
//   the runtime + router chunk URLs). The chunks themselves are public.
//
// Artifacts (under tools/bundle/ and tools/capture/):
//   tools/bundle/chunks/<hash>.js   cached chunk sources
//   tools/bundle/manifest.json      { id: hash }
//   tools/bundle/extracted.json     { hu: hash[] }
//   tools/bundle/new-zones.json     [{prefix, zone}]  (add to tools/zones.js)
//   tools/capture/bundle.tsv        zone⇥string (escaped) -> build-shards input

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChunkManifest, scriptSrcUrls } from './bundle/manifest.js';
import { extractStrings } from './bundle/extract-strings.js';
import { parseRoutes, mapStringsToZones } from './bundle/route-map.js';
import { zoneForRoute, buildIndex } from './zones.js';
import { makeHuFilter, looksLikeNoise } from './lib/filters.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_BASE = 'https://assets.billingo.hu/nuxt/';
const SHELL = 'https://app.billingo.hu/n/dashboard';

// Same escaping build-shards' unescapeTsv reverses: \ -> \\, newline -> \n, etc.
function escapeTsv(s) {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
}

async function fetchText(url, cookieHeader) {
  const res = await fetch(url, cookieHeader ? { headers: { cookie: cookieHeader } } : undefined);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

// Minimal Netscape cookie jar -> "name=value; ..." header for app.billingo.hu.
function cookieHeader(jarPath) {
  const pairs = [];
  for (const line of fs.readFileSync(jarPath, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const a = line.split('\t');
    if (a.length >= 7 && /billingo\.hu$/.test(a[0].replace(/^\./, ''))) pairs.push(`${a[5]}=${a[6]}`);
  }
  return pairs.join('; ');
}

async function main() {
  const jar = process.argv[2];
  if (!jar) { console.error('usage: node tools/extract-bundle.js <cookie-jar.txt>'); process.exit(1); }
  const bundleDir = path.join(ROOT, 'tools/bundle');
  const chunkDir = path.join(bundleDir, 'chunks');
  const captureDir = path.join(ROOT, 'tools/capture');
  fs.mkdirSync(chunkDir, { recursive: true });
  fs.mkdirSync(captureDir, { recursive: true });

  // 1. Discover: shell -> script urls -> find runtime (manifest) + router chunks.
  const shell = await fetchText(SHELL, cookieHeader(jar));
  const shellUrls = scriptSrcUrls(shell).filter((u) => u.startsWith(ASSET_BASE));
  if (shellUrls.length === 0) throw new Error('no assets.billingo.hu/nuxt scripts in shell — cookie expired?');
  let manifest = {};
  for (const u of shellUrls) {
    const src = await fetchText(u);
    const m = parseChunkManifest(src);
    if (Object.keys(m).length > Object.keys(manifest).length) manifest = m;
  }
  if (Object.keys(manifest).length === 0) throw new Error('chunk manifest not found in shell scripts');
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest: ${Object.keys(manifest).length} chunks`);

  // 2. Fetch all chunks (hash-cached). The set is the lazy manifest chunks UNION
  //    the shell-preloaded entry chunks — the latter (runtime, main, AND the router
  //    chunk b19efaa) are NOT in the lazy manifest yet hold the route table and a
  //    large share of the strings, so they must be included.
  const shellHashes = shellUrls.map((u) => u.split('/').pop().replace(/\.js$/, ''));
  const hashes = [...new Set([...Object.values(manifest), ...shellHashes])];
  let fetched = 0;
  await Promise.all(hashes.map(async (h) => {
    const f = path.join(chunkDir, `${h}.js`);
    if (fs.existsSync(f) && fs.statSync(f).size > 0) return;
    try { fs.writeFileSync(f, await fetchText(ASSET_BASE + h + '.js')); fetched++; } catch {}
  }));
  console.log(`chunks on disk: ${hashes.length} (newly fetched ${fetched})`);

  // 3. Extract HU strings per chunk -> { hu: hash[] }.
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'dict/en.json'), 'utf8'));
  const isLikelyHu = makeHuFilter(new Set(Object.keys(en)), new Set(Object.values(en)));
  const extracted = {};
  const catalog = new Set(); // i18n-catalog strings: global -> _common
  let routerSrc = '';
  for (const h of hashes) {
    const f = path.join(chunkDir, `${h}.js`);
    if (!fs.existsSync(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (/path:"\/[a-z]/.test(src) && src.includes('component:')) routerSrc += src; // router chunk(s)
    const { strings, catalog: cat } = extractStrings(src, { isLikelyHu, looksLikeNoise });
    for (const s of strings) (extracted[s] ||= []).push(h);
    for (const s of cat) catalog.add(s);
  }
  fs.writeFileSync(path.join(bundleDir, 'extracted.json'), JSON.stringify(extracted, null, 2) + '\n');
  console.log(`extracted HU strings: ${Object.keys(extracted).length} (catalog -> _common: ${catalog.size})`);

  // 4. Map to zones (chunk -> route -> zone).
  const routes = parseRoutes(routerSrc);
  const idx = buildIndex();
  const { observed, newZones } = mapStringsToZones({
    extracted, manifest, routes, zoneForRoute: (p) => zoneForRoute(p, idx),
  });
  // The i18n catalog is loaded app-wide — a chunk-local zone would hide it on
  // every other page, so force every catalog string to _common.
  for (const s of catalog) if (observed[s]) observed[s] = ['_common'];
  fs.writeFileSync(path.join(bundleDir, 'new-zones.json'), JSON.stringify(newZones, null, 2) + '\n');
  console.log(`routes parsed: ${routes.length} | new zones to add: ${newZones.length}`);

  // 5. Write build-shards input. Drop strings that live ONLY in admin/auth areas
  //    (normal users can't see the admin panel; /auth is the legacy login) so we
  //    neither waste translation effort nor ship a dead shard. A string shared with
  //    a real zone keeps its non-excluded zones.
  const EXCLUDE = new Set(['admin', 'auth', 'test', 'uikit', 'misc', 'error', 'other']);
  const lines = [];
  for (const [hu, zones] of Object.entries(observed)) {
    const keep = zones.filter((z) => !EXCLUDE.has(z));
    if (keep.length === 0) continue; // admin/auth-only -> skip entirely
    for (const z of keep) lines.push(`${z}\t${escapeTsv(hu)}`);
  }
  fs.writeFileSync(path.join(captureDir, 'bundle.tsv'), lines.join('\n') + '\n');
  console.log(`wrote tools/capture/bundle.tsv (${lines.length} lines)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
}
