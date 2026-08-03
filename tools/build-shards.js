// tools/build-shards.js
// Moteur d'assignation (pur) + CLI d'IO (en bas de fichier).
// planShards décide, pour chaque string candidate, dans quel(s) shard(s) elle
// va, et quelles strings nécessitent une traduction (delta).

export const COMMON_SHARD = '_common';

// observed : { [huString]: zone[] }   (zones d'observation, peut contenir des doublons)
// existingKeys : Set<huString>        (clés déjà présentes dans le dico actuel)
// opts : { isLikelyHu, looksLikeNoise, chromeStrings, threshold,
//           rejected?: Set<hu>, hasHtmlMarkup?: (hu) => boolean }
//         `rejected` et `hasHtmlMarkup` sont optionnels : les tests unitaires
//         appellent planShards sans eux et gardent leur comportement d'origine.
// → { placement: Map<hu, Set<shard>>, delta: Set<hu> }
export function planShards(observed, existingKeys, opts) {
  const { isLikelyHu, looksLikeNoise, chromeStrings, threshold, rejected, hasHtmlMarkup } = opts;
  const placement = new Map();
  const delta = new Set();

  const candidates = new Set([...Object.keys(observed), ...existingKeys]);
  for (const hu of candidates) {
    const isExisting = existingKeys.has(hu);
    if (!isExisting) {
      // Rejet nominatif et PERSISTANT (dict/_rejected.json). looksLikeNoise juge la
      // forme ; ceci porte des décisions humaines que rien ne pouvait retenir avant,
      // de sorte que chaque capture ressuscitait le déchet déjà purgé. Ne s'applique
      // qu'aux candidats nouveaux : dict/en.json reste la source de vérité.
      if (rejected && rejected.has(hu)) continue;
      // Balises = rendu par v-html, jamais un nœud texte : clé morte par
      // construction. Les fragments utiles sont capturés séparément.
      if (hasHtmlMarkup && hasHtmlMarkup(hu)) continue;
      if (looksLikeNoise(hu)) continue;
      if (!isLikelyHu(hu)) continue;
    }
    const zones = observed[hu] ? [...new Set(observed[hu])] : [];
    let shards;
    if (chromeStrings.has(hu) || zones.length === 0 || zones.length >= threshold) {
      shards = new Set([COMMON_SHARD]);
    } else {
      shards = new Set(zones);
    }
    placement.set(hu, shards);
    if (!isExisting) delta.add(hu);
  }
  return { placement, delta };
}

// --- Reconstruction de la baseline d'observation ---------------------------
// tools/capture/ est gitignoré : sur un clone frais il n'y a AUCUN .tsv, donc
// readObserved() rend {} et planShards renverrait les 8 200 clés dans _common,
// détruisant les 20 autres shards et vidant _index.json. On reconstruit donc
// toujours une baseline depuis les shards DÉJÀ sur le disque : une clé présente
// dans dict/en/<zone>.json y a nécessairement été observée à la capture d'origine.
//
// LIMITE FONDAMENTALE de cette reconstruction : les shards sont notre propre
// sortie. Ils sont une preuve sur le LIEU d'observation d'une clé, jamais sur son
// EXISTENCE. Sans `knownKeys`, supprimer une clé de dict/en.json + dict/fr.json
// (l'unique source de vérité, cf. CLAUDE.md) ne la supprime pas : le run suivant
// la relit dans le shard qu'il a lui-même écrit, la replace, et la ré-écrit avec
// `en[hu] ?? ''`. L'état est auto-entretenu, aucune édition de la source ne peut
// plus le défaire. D'où le filtre : on ne garde de la baseline que les clés
// encore présentes dans dict/en.json ∪ dict/fr.json (union, pour ne pas perdre
// le placement d'une clé traduite d'un seul côté).
// Une capture FRAÎCHE, elle, a toujours le droit d'introduire une clé inconnue :
// c'est le chemin de découverte, et il passe par mergeObserved, pas par ici.
//
// Deux subtilités, apprises des shards réellement commités :
//   - une clé de _common retombe sur une liste de zones VIDE, ce que planShards
//     renvoie dans _common : le RÉSULTAT du placement est donc reproduit à
//     l'identique sans avoir à distinguer « 0 zone » de « ≥ seuil zones » ;
//   - _common et les shards de zone ne sont PAS disjoints sur le disque (807
//     clés vivent dans les deux). Pour ces clés _common GAGNE : « Dátum » ou
//     « Állapot » sont dans _common (donc chargées sur toutes les routes) et
//     dupliquées dans bank.json ; les lire depuis bank.json les ferait sortir
//     de _common et régresserait la couverture partout ailleurs. On ne
//     déclasse jamais une clé globale en clé de route ; seule une capture
//     fraîche a ce droit (voir mergeObserved).
//
// shardKeys : { [shard]: Iterable<hu> }
// knownKeys  : Set<hu> | null — clés existant dans la source de vérité. `null`
//              désactive le filtre (usage unitaire uniquement ; le CLI passe
//              toujours l'union dict/en.json + dict/fr.json).
// → { [hu]: zone[] }
export function baselineObserved(shardKeys, knownKeys = null) {
  const isKnown = (hu) => knownKeys === null || knownKeys.has(hu);
  const commonKeys = new Set([...(shardKeys[COMMON_SHARD] ?? [])].filter(isKnown));
  const observed = {};
  // Entrée explicite (liste vide) : la baseline est ainsi la liste complète des
  // clés vues, et planShards traite [] exactement comme « absente » → _common.
  for (const hu of commonKeys) observed[hu] = [];
  for (const [shard, keys] of Object.entries(shardKeys)) {
    if (shard === COMMON_SHARD) continue;
    for (const hu of keys) {
      if (commonKeys.has(hu)) continue; // _common gagne, cf. ci-dessus
      if (!isKnown(hu)) continue;       // clé supprimée de la source : reste supprimée
      (observed[hu] ||= []).push(shard);
    }
  }
  return observed;
}

// Superpose les observations fraîches (TSV) sur la baseline reconstruite.
// Précédence PAR CLÉ, dans les deux sens, et les deux sens comptent :
//   - une clé vue dans une capture prend SES zones TSV, qui REMPLACENT ses
//     zones baseline. Sans ce remplacement le placement deviendrait collant et
//     auto-entretenu : une clé ne pourrait plus jamais sortir de _common ni
//     abandonner une zone où elle n'apparaît plus.
//   - une clé absente des captures GARDE ses zones baseline. Sans ça, une
//     capture partielle (un seul .tsv, une seule route balayée) effondrerait
//     tout le reste du dico dans _common — le bug d'origine.
// Retourne un nouvel objet ; les entrées d'origine ne sont pas mutées.
export function mergeObserved(baseline, captured) {
  const merged = { ...baseline };
  for (const [hu, zones] of Object.entries(captured)) merged[hu] = [...zones];
  return merged;
}

// Compare l'ensemble des shards présents sur disque à celui qu'on s'apprête à
// écrire. `isShrinking` est le garde-fou : écrire moins de fichiers qu'il n'en
// existe signifie qu'on est en train d'en supprimer, ce qui est toujours une
// régression involontaire sauf demande explicite (--allow-shrink).
export function diffShardSets(existing, next) {
  const removed = [...existing].filter((s) => !next.has(s)).sort();
  const added = [...next].filter((s) => !existing.has(s)).sort();
  return { removed, added, isShrinking: next.size < existing.size };
}

// --- Garde-fou sur les VALEURS -------------------------------------------
// diffShardSets ne regarde que le NOMBRE DE FICHIERS. Il est donc aveugle au
// sinistre qu'il prétend couvrir : avec dict/fr.json = {} (écriture interrompue,
// merge raté), les 21 shards sont ré-écrits — même nombre, mêmes clés, valeurs
// toutes vides. Le run annonçait « aucun shard modifié » en détruisant les
// 7 938 traductions françaises, y compris la source de vérité. On compte donc
// aussi les traductions non vides, PAR LANGUE.
//
// shards : { [shard]: { [hu]: traduction } } → nombre de clés DISTINCTES traduites.
// Dédoublonné : ~800 clés vivent à la fois dans _common et dans un shard de zone,
// un total par fichier varierait au gré du placement alors qu'on veut mesurer la
// perte de TRADUCTIONS, pas un déplacement.
export function countTranslated(shards) {
  const translated = new Set();
  for (const obj of Object.values(shards)) {
    for (const [hu, value] of Object.entries(obj)) {
      if (typeof value === 'string' && value !== '') translated.add(hu);
    }
  }
  return translated.size;
}

// Seuil de perte toléré, en proportion des traductions déjà sur le disque.
// Il doit séparer deux choses de tailles très différentes :
//   - hygiène normale : retirer quelques dizaines de clés mortes sur ~7 900,
//     soit < 1 % (la purge historique de 272 clés = 3,4 %) — doit passer SANS flag ;
//   - sinistre : un dico vidé ou tronqué perd 50 à 100 % — doit s'arrêter net.
// 10 % laisse une marge confortable au premier cas tout en restant à un ordre de
// grandeur du second. Volontairement en proportion et non en absolu : un seuil
// absolu généreux (« 50 clés ») laisserait passer l'effacement complet d'un
// petit dico.
export const MAX_TRANSLATION_LOSS_RATIO = 0.10;

// before / after : { en: n, fr: n } → { lost: [{ lang, before, after, allowed }], isLosing }
export function diffTranslations(before, after, ratio = MAX_TRANSLATION_LOSS_RATIO) {
  const lost = [];
  for (const lang of Object.keys(before)) {
    const from = before[lang];
    const to = after[lang] ?? 0;
    const allowed = Math.floor(from * ratio);
    if (from - to > allowed) lost.push({ lang, before: from, after: to, allowed });
  }
  return { lost, isLosing: lost.length > 0 };
}

// { [shard]: nombre de clés } depuis un placement, pour le résumé avant/après.
export function countByShard(placement) {
  const counts = {};
  for (const shards of placement.values()) {
    for (const shard of shards) counts[shard] = (counts[shard] ?? 0) + 1;
  }
  return counts;
}

// --- CLI ------------------------------------------------------------------
// Exécuté directement : node tools/build-shards.js [--allow-shrink]
// Idempotent et non destructif : sans .tsv de capture, il ré-écrit exactement
// le découpage déjà sur le disque (cf. baselineObserved).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './zones.js';
import { makeHuFilter, looksLikeNoise, hasHtmlMarkup, CHROME_STRINGS, COMMON_ZONE_THRESHOLD }
  from './lib/filters.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOG = '[build-shards]';

function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // Un JSON cassé doit arrêter le build : le laisser passer reviendrait à
    // repartir d'un dico vide et donc à tout effondrer dans _common.
    throw new Error(`${LOG} JSON invalide dans ${p} : ${e.message}`);
  }
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

// { [shard]: { [hu]: traduction } } depuis dict/<lang>/*.json. Dossier absent → {}.
// On lit les VALEURS (et pas seulement les clés) parce que le garde-fou doit
// comparer les traductions non vides d'avant et d'après.
function readShardValues(dir) {
  const shards = {};
  if (!fs.existsSync(dir)) return shards;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    shards[f.slice(0, -'.json'.length)] = readJson(path.join(dir, f), {});
  }
  return shards;
}

// { [shard]: {…} } → { [shard]: hu[] }
function shardKeysOf(shards) {
  return Object.fromEntries(Object.entries(shards).map(([s, obj]) => [s, Object.keys(obj)]));
}

// Union des deux langues : un shard n'existant que dans dict/fr compte quand même
// comme observé (les deux dossiers sont censés être jumeaux, ne pas le supposer).
function unionShardKeys(a, b) {
  const union = {};
  for (const src of [a, b]) {
    for (const [shard, keys] of Object.entries(src)) {
      union[shard] = [...new Set([...(union[shard] ?? []), ...keys])];
    }
  }
  return union;
}

function sortedByHu(obj) {
  return Object.fromEntries(
    Object.keys(obj).sort((a, b) => a.localeCompare(b, 'hu')).map((k) => [k, obj[k]]));
}

// Résumé avant/après : sans lui, une refonte silencieuse du découpage passe
// inaperçue jusqu'au prochain `git diff`.
// `tBefore` / `tAfter` = { en, fr } traductions non vides : sans elles, le résumé
// dit « aucun shard modifié » pendant qu'une langue entière part à la poubelle.
function reportSummary(logger, before, after, tBefore, tAfter) {
  const shards = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = shards
    .filter((s) => (before[s] ?? 0) !== (after[s] ?? 0))
    .map((s) => `${s} ${before[s] ?? 0}→${after[s] ?? 0}`);
  const total = (counts) => Object.values(counts).reduce((n, v) => n + v, 0);
  const translated = (t) => `traduites en ${t.en} / fr ${t.fr}`;
  logger.log(`${LOG} avant : ${Object.keys(before).length} shards, ${total(before)} entrées, `
    + translated(tBefore));
  logger.log(`${LOG} après : ${Object.keys(after).length} shards, ${total(after)} entrées, `
    + translated(tAfter));
  logger.log(changed.length
    ? `${LOG} shards modifiés : ${changed.join(', ')}`
    : `${LOG} aucun shard modifié`);
}

// `root` et `logger` sont injectables pour que les tests exercent le garde-fou
// sur une arborescence jetable au lieu du vrai dict/. Ne touche pas à
// process.exitCode : c'est le wrapper CLI qui traduit `ok:false` en code retour.
// → { ok, shards, index, delta, removed, added, lost, translated }
export function main({ root = ROOT, argv = process.argv.slice(2), logger = console } = {}) {
  const allowShrink = argv.includes('--allow-shrink');
  const en = readJson(path.join(root, 'dict/en.json'), {});
  const fr = readJson(path.join(root, 'dict/fr.json'), {});
  const captureDir = path.join(root, 'tools/capture');

  const enOnDisk = readShardValues(path.join(root, 'dict/en'));
  const frOnDisk = readShardValues(path.join(root, 'dict/fr'));
  const onDisk = unionShardKeys(shardKeysOf(enOnDisk), shardKeysOf(frOnDisk));
  // Les shards disent OÙ une clé a été vue ; seuls dict/en.json + dict/fr.json
  // disent SI elle existe. Cf. le commentaire de baselineObserved.
  const knownKeys = new Set([...Object.keys(en), ...Object.keys(fr)]);
  const baseline = baselineObserved(onDisk, knownKeys);
  const captured = readObserved(captureDir);
  const observed = mergeObserved(baseline, captured);
  logger.log(`${LOG} baseline : ${Object.keys(baseline).length} clés reconstruites depuis dict/`
    + ` | captures : ${Object.keys(captured).length} clés dans tools/capture/*.tsv`);

  // UNION en ∪ fr, pas `en` seul : une clé traduite d'un seul côté (le français
  // d'abord, ce qui arrive dès qu'on ajoute une entrée en deux temps) doit rester
  // candidate. Avec `en` seul elle sortait du plan, et comme les monolithiques sont
  // réécrits DEPUIS ce plan, la traduction française était supprimée en silence —
  // invisible au garde-fou sur les valeurs, qui compare les shards avant/après et
  // ne voyait la clé dans ni l'un ni l'autre.
  const existingKeys = knownKeys;
  const rejectedFile = readJson(path.join(root, 'dict/_rejected.json'), { rejected: {} });
  const rejected = new Set(Object.keys(rejectedFile.rejected || {}));
  const opts = {
    rejected,
    hasHtmlMarkup,
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

  // Premier garde-fou, sur la STRUCTURE : on n'écrase pas un découpage sain par
  // un plus pauvre. Sans lui le run supprimerait des shards et viderait
  // _index.json. Il ne dit rien des valeurs — d'où le second, juste après.
  const existingShards = new Set(Object.keys(onDisk));
  const nextShards = new Set(Object.keys(shardsEn));
  const { removed, added, isShrinking } = diffShardSets(existingShards, nextShards);
  const before = Object.fromEntries(Object.entries(onDisk).map(([s, k]) => [s, k.length]));
  const translatedBefore = { en: countTranslated(enOnDisk), fr: countTranslated(frOnDisk) };
  const translatedAfter = { en: countTranslated(shardsEn), fr: countTranslated(shardsFr) };
  reportSummary(logger, before, countByShard(placement), translatedBefore, translatedAfter);
  const { lost, isLosing } = diffTranslations(translatedBefore, translatedAfter);
  const aborted = { ok: false, shards: existingShards.size, index: 0, delta: delta.size,
    removed, added, lost, translated: { before: translatedBefore, after: translatedAfter } };
  // Angle mort où les DEUX garde-fous sont muets : plus aucun shard sur disque ET
  // aucune capture. `isShrinking` compare des tailles (3 < 0 est faux) et la perte
  // de traductions part de 0, donc les deux passent — alors que c'est justement le
  // cas le plus destructeur : tout retombe dans _common et _index.json perd ses
  // routes. Sans shard ni capture, il n'y a aucune preuve de placement : on refuse.
  if (existingShards.size === 0 && Object.keys(captured).length === 0 && !allowShrink) {
    logger.error(`${LOG} ABANDON : aucun shard dans dict/en|fr/ et aucune capture dans`
      + ` tools/capture/*.tsv — rien ne dit dans quelle zone placer les clés.`);
    logger.error(`${LOG} tout retomberait dans _common et _index.json perdrait ses routes.`);
    logger.error(`${LOG} restaurer dict/en/ et dict/fr/ (ils sont versionnés : git checkout dict),`
      + ` ou rejouer les outils de capture. --allow-shrink pour forcer.`);
    return aborted;
  }
  if (isShrinking && !allowShrink) {
    logger.error(`${LOG} ABANDON : ce run écrirait ${nextShards.size} shards alors que`
      + ` ${existingShards.size} existent sur disque. Rien n'a été écrit.`);
    logger.error(`${LOG} seraient supprimés : ${removed.join(', ') || '(aucun, comptes divergents)'}`);
    logger.error(`${LOG} cause probable : tools/capture/*.tsv absent ou partiel, ou dict/en.json`
      + ` vide. Rejouer les outils de capture, ou relancer avec --allow-shrink si c'est voulu.`);
    return aborted;
  }
  // Second garde-fou, sur les valeurs : même nombre de shards, mais traductions
  // perdues. C'est le cas dict/fr.json = {} — celui que le compte de fichiers
  // laissait passer avec un « aucun shard modifié » rassurant.
  if (isLosing && !allowShrink) {
    for (const { lang, before: from, after: to, allowed } of lost) {
      logger.error(`${LOG} ABANDON : ce run détruirait des traductions ${lang} :`
        + ` ${from} → ${to} (perte ${from - to}, tolérée ${allowed}). Rien n'a été écrit.`);
    }
    logger.error(`${LOG} cause probable : dict/en.json ou dict/fr.json vidé ou tronqué`
      + ` (écriture interrompue, merge raté). Restaurer le dico depuis git, ou relancer avec`
      + ` --allow-shrink si la perte est réellement voulue.`);
    return aborted;
  }
  if (removed.length) logger.warn(`${LOG} shards supprimés : ${removed.join(', ')}`);
  if (added.length) logger.log(`${LOG} nouveaux shards : ${added.join(', ')}`);

  // Écrit puis nettoie fichier par fichier — un rmSync du dossier entier
  // laisserait dict/<lang>/ vide si le run échouait au milieu.
  function writeShards(langDir, shards) {
    const dir = path.join(root, 'dict', langDir);
    fs.mkdirSync(dir, { recursive: true });
    for (const [shard, obj] of Object.entries(shards)) {
      fs.writeFileSync(path.join(dir, `${shard}.json`),
        JSON.stringify(sortedByHu(obj), null, 2) + '\n');
    }
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      if (Object.hasOwn(shards, f.slice(0, -'.json'.length))) continue;
      fs.rmSync(path.join(dir, f));
    }
  }
  writeShards('en', shardsEn);
  writeShards('fr', shardsFr);

  // A zone from tools/zones.js that collected no string has no shard file — keep
  // it out of the index, otherwise the runtime loader fetches a 404 on every
  // visit to that route.
  const index = buildIndex().filter((e) => nextShards.has(e.shard));
  fs.writeFileSync(path.join(root, 'dict/_index.json'),
    JSON.stringify(index, null, 2) + '\n');

  function merge(shards) {
    const all = {};
    for (const obj of Object.values(shards)) Object.assign(all, obj);
    return sortedByHu(all);
  }
  fs.writeFileSync(path.join(root, 'dict/en.json'), JSON.stringify(merge(shardsEn), null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'dict/fr.json'), JSON.stringify(merge(shardsFr), null, 2) + '\n');

  // tools/capture/ est gitignoré, donc absent d'un clone frais : le créer avant
  // d'écrire, sinon le run se termine sur un ENOENT après avoir tout réécrit.
  fs.mkdirSync(captureDir, { recursive: true });
  const deltaByShard = {};
  for (const hu of delta) {
    for (const shard of placement.get(hu)) (deltaByShard[shard] ||= []).push(hu);
  }
  for (const k of Object.keys(deltaByShard)) deltaByShard[k].sort((a, b) => a.localeCompare(b, 'hu'));
  fs.writeFileSync(path.join(captureDir, 'delta.json'),
    JSON.stringify(deltaByShard, null, 2) + '\n');
  // La carte effectivement utilisée (baseline + captures), pas les seules captures :
  // c'est elle qui explique le placement obtenu.
  fs.writeFileSync(path.join(captureDir, 'observed.json'),
    JSON.stringify(observed, null, 2) + '\n');

  logger.log(`${LOG} shards : ${nextShards.size} | index : ${index.length} routes`
    + ` | delta à traduire : ${delta.size}`);
  return { ok: true, shards: nextShards.size, index: index.length, delta: delta.size,
    removed, added, lost, translated: { before: translatedBefore, after: translatedAfter } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!main().ok) process.exitCode = 1;
}
