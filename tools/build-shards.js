// tools/build-shards.js
// Moteur d'assignation (pur) + CLI d'IO (en bas de fichier).
// planShards décide, pour chaque string candidate, dans quel(s) shard(s) elle
// va, et quelles strings nécessitent une traduction (delta).

// observed : { [huString]: zone[] }   (zones d'observation, peut contenir des doublons)
// existingKeys : Set<huString>        (clés déjà présentes dans le dico actuel)
// opts : { isLikelyHu, looksLikeNoise, chromeStrings, threshold }
// → { placement: Map<hu, Set<shard>>, delta: Set<hu> }
export function planShards(observed, existingKeys, opts) {
  const { isLikelyHu, looksLikeNoise, chromeStrings, threshold } = opts;
  const placement = new Map();
  const delta = new Set();

  const candidates = new Set([...Object.keys(observed), ...existingKeys]);
  for (const hu of candidates) {
    const isExisting = existingKeys.has(hu);
    if (!isExisting) {
      if (looksLikeNoise(hu)) continue;
      if (!isLikelyHu(hu)) continue;
    }
    const zones = observed[hu] ? [...new Set(observed[hu])] : [];
    let shards;
    if (chromeStrings.has(hu) || zones.length === 0 || zones.length >= threshold) {
      shards = new Set(['_common']);
    } else {
      shards = new Set(zones);
    }
    placement.set(hu, shards);
    if (!isExisting) delta.add(hu);
  }
  return { placement, delta };
}

// --- CLI ------------------------------------------------------------------
// Exécuté directement : node tools/build-shards.js
// Idempotent. Si aucun .tsv de capture n'existe, ré-éclate simplement le dico
// actuel en shards (utile pour valider le format avant toute capture).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './zones.js';
import { makeHuFilter, looksLikeNoise, CHROME_STRINGS, COMMON_ZONE_THRESHOLD }
  from './lib/filters.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function readJson(p, fallback) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
}

// Reverses the escaping done by the capture writers (crawl-rendered.js): one
// pass so "\\" -> "\", "\n" -> newline, "\t" -> tab, "\r" -> CR.
function unescapeTsv(s) {
  return s.replace(/\\(.)/g, (_, c) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c);
}

// Agrège tous les tools/capture/*.tsv (lignes "zone\tstring", string échappée)
// en { string: zone[] }.
function readObserved(captureDir) {
  const observed = {};
  if (!fs.existsSync(captureDir)) return observed;
  for (const f of fs.readdirSync(captureDir)) {
    if (!f.endsWith('.tsv')) continue;
    for (const line of fs.readFileSync(path.join(captureDir, f), 'utf8').split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const zone = line.slice(0, tab);
      const s = unescapeTsv(line.slice(tab + 1));
      if (!s) continue;
      (observed[s] ||= []).push(zone);
    }
  }
  return observed;
}

function main() {
  const en = readJson(path.join(ROOT, 'dict/en.json'), {});
  const fr = readJson(path.join(ROOT, 'dict/fr.json'), {});
  const captureDir = path.join(ROOT, 'tools/capture');
  const observed = readObserved(captureDir);

  const existingKeys = new Set(Object.keys(en));
  const opts = {
    isLikelyHu: makeHuFilter(existingKeys, new Set(Object.values(en))),
    looksLikeNoise,
    chromeStrings: CHROME_STRINGS,
    threshold: COMMON_ZONE_THRESHOLD,
  };

  const { placement, delta } = planShards(observed, existingKeys, opts);

  const shardsEn = {};
  const shardsFr = {};
  for (const [hu, shardSet] of placement) {
    for (const shard of shardSet) {
      (shardsEn[shard] ||= {})[hu] = en[hu] ?? '';
      (shardsFr[shard] ||= {})[hu] = fr[hu] ?? '';
    }
  }

  function writeShards(langDir, shards) {
    const dir = path.join(ROOT, 'dict', langDir);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [shard, obj] of Object.entries(shards)) {
      const sorted = Object.fromEntries(
        Object.keys(obj).sort((a, b) => a.localeCompare(b, 'hu')).map((k) => [k, obj[k]]));
      fs.writeFileSync(path.join(dir, `${shard}.json`),
        JSON.stringify(sorted, null, 2) + '\n');
    }
  }
  writeShards('en', shardsEn);
  writeShards('fr', shardsFr);

  fs.writeFileSync(path.join(ROOT, 'dict/_index.json'),
    JSON.stringify(buildIndex(), null, 2) + '\n');

  function merge(shards) {
    const all = {};
    for (const obj of Object.values(shards)) Object.assign(all, obj);
    return Object.fromEntries(
      Object.keys(all).sort((a, b) => a.localeCompare(b, 'hu')).map((k) => [k, all[k]]));
  }
  fs.writeFileSync(path.join(ROOT, 'dict/en.json'), JSON.stringify(merge(shardsEn), null, 2) + '\n');
  fs.writeFileSync(path.join(ROOT, 'dict/fr.json'), JSON.stringify(merge(shardsFr), null, 2) + '\n');

  const deltaByShard = {};
  for (const hu of delta) {
    for (const shard of placement.get(hu)) (deltaByShard[shard] ||= []).push(hu);
  }
  for (const k of Object.keys(deltaByShard)) deltaByShard[k].sort((a, b) => a.localeCompare(b, 'hu'));
  fs.writeFileSync(path.join(captureDir, 'delta.json'),
    JSON.stringify(deltaByShard, null, 2) + '\n');
  fs.writeFileSync(path.join(captureDir, 'observed.json'),
    JSON.stringify(observed, null, 2) + '\n');

  console.log(`shards: ${Object.keys(shardsEn).length} | delta à traduire: ${delta.size}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
