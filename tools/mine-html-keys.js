// tools/mine-html-keys.js
// Moteur d'extraction (pur) + CLI d'IO (en bas de fichier).
//
// ~242 clés de dict/en.json sont des FRAGMENTS HTML : Billingo les rend via
// v-html, le navigateur les parse en DOM, et aucun nœud texte ne peut donc
// jamais égaler le fragment littéral. Ces clés sont mortes au runtime, mais
// leurs TRADUCTIONS sont exactes et déjà relues. On les découpe donc en
// segments (un segment = un nœud texte réel) et on aligne positionnellement
// HU / EN / FR pour en dériver des paires qui, elles, peuvent matcher.
//
// Trois règles non négociables, apprises de l'analyse préalable :
//   1. AUCUNE écriture dans dict/*.json. Le zip positionnel est faux dans ~15 %
//      des cas (réordonnancement des mots à travers les balises inline), donc
//      chaque paire est un CANDIDAT à relire, jamais un fait acquis.
//   2. La clé existante GAGNE toujours. 83 % des segments sont déjà des clés du
//      dico (crawl-rendered.js a déjà moissonné les nœuds texte rendus) ; leur
//      valeur est relue à la main et TRANSLATIONS.md documente des choix
//      fiscaux/légaux qu'une re-dérivation mécanique écraserait en silence.
//   3. Rien n'est jeté en silence : tout segment refusé sort dans `rejected`
//      avec son motif, tout parent non alignable sort dans `unaligned`.
//
// Le rendement est faible par construction (une poignée de paires) : ce n'est
// pas un défaut de l'outil, c'est que le pipeline de capture couvre déjà les
// segments. L'auto-test de similarité (cf. selfTest) est la partie réutilisable :
// il mesure à chaque run le taux de zip erroné sur les segments déjà connus.

import { JSDOM } from 'jsdom';
import { hasHtmlMarkup as sharedHasHtmlMarkup } from './lib/filters.js';

export const COMMON_SHARD = '_common';

// Une balise BIEN FORMÉE : ouvrante ou fermante, attributs sans chevron interne,
// slash auto-fermant optionnel. Volontairement stricte : 3 clés du dico portent
// un chevron isolé sans balise valide (résidu d'extraction tronqué) et n'ont
// aucun segment exploitable, autant ne pas les faire entrer dans le moteur.
export const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9]*(\s[^<>]*)?\/?>/;

// Résidu de markup dans un SEGMENT : chevron nu, ou paire attribut="valeur".
// Un vrai nœud texte n'en contient jamais ; sa présence signale une clé tronquée.
const MARKUP_RESIDUE_RE = /[<>]|=\s*["']/;

const WS_RUN = /\s+/g;
const LETTERS = /\p{L}/gu;
// Même définition que src/translator.js : ':name' non précédé de mot ni de ':',
// ce qui exclut '10:00', 'https://…' et 'text-decoration:underline'.
const newTokenRe = () => /(?<![\w:]):([a-zA-Z_][a-zA-Z0-9_]*)/g;

// Nœuds dont le contenu n'est jamais traduit par src/dom-walker.js
// (SKIP_TEXT_TAGS) : en extraire un segment produirait une clé inatteignable.
const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);

// Un segment plus court que ça n'identifie rien et matcherait du bruit.
const MIN_SEGMENT_LENGTH = 3;
const MIN_SEGMENT_LETTERS = 3;
// Garde-fou spécifique aux clés à token : compileNamedPattern() de
// src/translator.js transforme toute clé portant un ':token' en regex et
// n'exige que MIN_PATTERN_LETTERS = 2 de texte littéral. Une paire minée du
// genre « A(z) :bankName » compilerait donc un matcher quasi universel qui
// avalerait du texte sans rapport. 8 lettres littérales minimum.
const MIN_TOKEN_LITERAL_LETTERS = 8;
// Au-delà de ce taux de zips manifestement faux (Jaccard < 0.2 contre les
// valeurs déjà curées), l'alignement positionnel n'est plus crédible sur ce
// dico : le CLI sort en erreur pour forcer une relecture du corpus.
export const LOW_SIMILARITY_THRESHOLD = 0.2;
export const MAX_LOW_SIMILARITY_RATE = 0.25;

export const REJECT = {
  MARKUP: 'résidu de markup',
  NO_LETTER: 'aucune lettre',
  BARE_TOKEN: 'token Laravel seul',
  TOO_SHORT: 'trop court',
  IDENTITY: 'HU = EN = FR (identité)',
  EXISTING_KEY: 'clé déjà au dico (la clé existante gagne)',
  EXISTING_KEY_BLANK: 'clé déjà au dico avec valeur vide (à traiter à la main)',
  THIN_TOKEN_LITERAL: 'token Laravel avec littéral trop mince',
  LEADING_FRAGMENT: 'fragment de phrase (commence par - ou ,)',
  EMPTY_TRANSLATION: 'traduction dérivée vide',
  CONFLICT: 'conflit interne (même HU, traductions divergentes)',
};

// Motifs de refus qui NE font PAS perdre de couverture : soit le segment est
// déjà couvert par une clé curée, soit il n'a rien à traduire. Ils n'empêchent
// donc pas de proposer la suppression du parent (cf. dropParents).
const COVERED_BY_REJECT = new Set([
  REJECT.MARKUP,        // ne peut de toute façon jamais matcher un nœud texte
  REJECT.NO_LETTER,
  REJECT.BARE_TOKEN,
  REJECT.TOO_SHORT,
  REJECT.IDENTITY,      // rien à traduire
  REJECT.EXISTING_KEY,  // la clé curée assure déjà la couverture
]);

// Délègue au prédicat PARTAGÉ (tools/lib/filters.js) au lieu d'en garder une copie :
// c'est exactement le test que planShards applique pour refuser une clé porteuse de
// balises. Deux regex jumelles finiraient par diverger, et une divergence signifie
// que ce minage proposerait des segments pour des clés que build-shards écarterait,
// ou l'inverse. HTML_TAG_RE reste exporté, il sert au découpage local.
export const hasHtmlMarkup = (s) => typeof s === 'string' && sharedHasHtmlMarkup(s);

// Même normalisation que normalizeWs() de src/translator.js : runs d'espaces
// (NBSP incluse, \s la couvre) réduits à un espace, puis trim. C'est LA
// condition pour que la clé dérivée matche : le nœud texte rendu est indenté et
// replié par le navigateur, et la couche 2 du translator compare des formes
// normalisées. Une clé gardant les retours à la ligne du fragment ne matcherait
// jamais et casserait en plus l'assertion « clé non trimée » de dict-integrity.
export const normalizeSegment = (s) => s.replace(WS_RUN, ' ').trim();

const countLetters = (s) => (s.match(LETTERS) || []).length;
const hasToken = (s) => newTokenRe().test(s);
// Texte littéral hors tokens : c'est lui qui identifie la clé pour la couche 4.
const stripTokens = (s) => s.replace(newTokenRe(), ' ');

// Découpe un fragment HTML en la liste des nœuds texte que le navigateur en
// produirait, normalisés. JSDOM.fragment() est tolérant : il absorbe les balises
// non fermées et les fermetures orphelines des clés tronquées au lieu de jeter.
export function segments(html) {
  if (typeof html !== 'string' || html === '') return [];
  const frag = JSDOM.fragment(html);
  const out = [];
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = normalizeSegment(child.textContent);
        if (text !== '') out.push(text);
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (SKIP_TEXT_TAGS.has(child.nodeName)) continue;
      visit(child);
    }
  };
  visit(frag);
  return out;
}

// Échappement IDENTIQUE à celui des writers de capture (crawl-rendered.js), que
// unescapeTsv() de build-shards.js inverse en une passe. L'ordre compte : le
// backslash d'abord, sinon on ré-échapperait les backslashes qu'on vient
// d'introduire.
export const escapeTsv = (s) =>
  s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');

// --- similarité (auto-test) ------------------------------------------------
// Jaccard sur les tokens mot : mesure grossière mais suffisante pour séparer
// « paraphrase » de « valeur d'un autre segment » (les vrais zips ratés
// tombent sous 0.2 parce qu'ils ne partagent aucun mot).
export function jaccard(a, b) {
  const tokens = (s) => new Set(s.toLowerCase().match(/\p{L}+/gu) || []);
  const setA = tokens(a);
  const setB = tokens(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared += 1;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

// --- moteur ---------------------------------------------------------------

// Premier motif de refus applicable, dans un ordre fixe (du moins coûteux au
// plus coûteux, et du plus structurel au plus discutable) ; null = accepté.
function rejectReason(hu, en, fr, keySet, normKeySet, dict) {
  if ([hu, en, fr].some((s) => MARKUP_RESIDUE_RE.test(s))) return REJECT.MARKUP;
  if (countLetters(hu) === 0) return REJECT.NO_LETTER;
  // ':type' porte des lettres : ce test doit venir APRÈS NO_LETTER et avant
  // TOO_SHORT, sinon un token nu passerait pour un mot.
  if (hasToken(hu) && countLetters(stripTokens(hu)) === 0) return REJECT.BARE_TOKEN;
  if (hu.length < MIN_SEGMENT_LENGTH || countLetters(hu) < MIN_SEGMENT_LETTERS) {
    return REJECT.TOO_SHORT;
  }
  if (hu === en && hu === fr) return REJECT.IDENTITY;

  // Règle 2 : la clé existante gagne, sans condition. On distingue le cas de la
  // valeur vide (marqueur « non traduit » explicite du dico) parce que lui seul
  // mérite une passe manuelle — mais on ne le remplit pas automatiquement, une
  // valeur mal zippée y atterrirait sans relecture.
  const norm = normalizeSegment(hu);
  if (keySet.has(hu) || normKeySet.has(norm)) {
    const existing = dict.en[hu] ?? dict.en[norm] ?? '';
    return existing === '' ? REJECT.EXISTING_KEY_BLANK : REJECT.EXISTING_KEY;
  }

  if (hasToken(hu) && countLetters(stripTokens(hu)) < MIN_TOKEN_LITERAL_LETTERS) {
    return REJECT.THIN_TOKEN_LITERAL;
  }
  // Miroir de looksLikeNoise() (tools/lib/filters.js), qui rejette déjà une
  // virgule initiale : un segment ouvrant sur '-' ou ',' est un morceau de
  // phrase coupé par une balise inline, pas une unité traduisible.
  if (/^[-,]/.test(hu)) return REJECT.LEADING_FRAGMENT;
  // Invariant du runtime : une valeur vide vaut « raté », jamais un affichage
  // blanc. Une paire dont la traduction dérivée est vide est donc inutilisable.
  if (en === '' || fr === '') return REJECT.EMPTY_TRANSLATION;
  return null;
}

// Zones du parent → zones de la paire dérivée. Si le parent vit dans _common,
// on n'émet QUE _common : c'est la précédence que build-shards.js applique déjà
// (cf. baselineObserved, « _common gagne »), et déclasser une clé globale en
// clé de route régresserait la couverture partout ailleurs.
function normalizeZones(zones) {
  const set = new Set(zones ?? []);
  if (set.size === 0 || set.has(COMMON_SHARD)) return [COMMON_SHARD];
  return [...set].sort();
}

// dicts : { en, fr } monolithiques ; zonesByKey : { [cléParente]: zone[] }.
// Retourne un rapport complet ; ne mute aucune entrée et n'écrit rien.
export function minePairs({ en, fr, zonesByKey = {} }) {
  const keySet = new Set(Object.keys(en));
  const normKeySet = new Set([...keySet].map(normalizeSegment));
  const dict = { en, fr };

  const pairs = [];
  const byHu = new Map(); // hu → paire acceptée (dédoublonnage inter-parents)
  const rejected = [];
  const unaligned = [];
  const similarities = [];
  const parents = [];

  for (const key of Object.keys(en)) {
    if (!hasHtmlMarkup(key)) continue;
    const enValue = en[key] ?? '';
    const frValue = fr[key] ?? '';
    const huSegs = segments(key);

    if (enValue === '' || frValue === '') {
      unaligned.push({ from: key, hu: huSegs.length, en: 0, fr: 0,
        reason: 'traduction parente vide' });
      continue;
    }
    const enSegs = segments(enValue);
    const frSegs = segments(frValue);
    // Compteurs égaux : condition NÉCESSAIRE (et pas suffisante, cf. selfTest).
    // Divergence = le traducteur a réordonné ou fusionné le markup, le segment k
    // de HU n'est plus le segment k de EN. On ne devine pas.
    if (huSegs.length === 0
      || huSegs.length !== enSegs.length || huSegs.length !== frSegs.length) {
      unaligned.push({ from: key, hu: huSegs.length, en: enSegs.length, fr: frSegs.length,
        reason: huSegs.length === 0 ? 'aucun segment' : 'compteurs de segments divergents' });
      continue;
    }

    // Poussé AVANT la boucle : un conflit détecté plus tard doit pouvoir
    // décrémenter la couverture du parent qui avait fourni la première version.
    const parent = { key, segments: huSegs.length, mined: 0, covered: 0 };
    parents.push(parent);

    for (let i = 0; i < huSegs.length; i++) {
      const hu = huSegs[i];
      const enSeg = enSegs[i];
      const frSeg = frSegs[i];
      const reason = rejectReason(hu, enSeg, frSeg, keySet, normKeySet, dict);

      // Auto-test : les segments déjà présents au dico sont notre seule vérité
      // terrain. Si le zip positionnel était fiable, la valeur dérivée serait
      // une paraphrase de la valeur curée.
      if (reason === REJECT.EXISTING_KEY) {
        const norm = normalizeSegment(hu);
        const curated = en[hu] ?? en[norm] ?? '';
        similarities.push({ hu, curated, derived: enSeg, score: jaccard(curated, enSeg), from: key });
      }

      if (reason) {
        rejected.push({ hu, en: enSeg, fr: frSeg, from: key, reason });
        if (COVERED_BY_REJECT.has(reason)) parent.covered += 1;
        continue;
      }

      const seen = byHu.get(hu);
      if (seen === null) {
        // HU déjà invalidé par un conflit antérieur : il reste invalidé.
        rejected.push({ hu, en: enSeg, fr: frSeg, from: key, reason: REJECT.CONFLICT });
        continue;
      }
      if (seen) {
        // Deux parents donnent le même HU. Identique → on fusionne simplement
        // les zones. Divergent → on invalide LES DEUX versions : arbitrer entre
        // deux dérivations contradictoires demanderait précisément le jugement
        // humain que cet outil refuse de simuler.
        if (seen.en === enSeg && seen.fr === frSeg) {
          seen.zones = normalizeZones([...seen.zones, ...normalizeZones(zonesByKey[key])]);
          parent.covered += 1;
          parent.mined += 1;
          continue;
        }
        byHu.set(hu, null);
        seen.parent.covered -= 1;
        seen.parent.mined -= 1;
        rejected.push({ hu, en: seen.en, fr: seen.fr, from: seen.from,
          reason: REJECT.CONFLICT, conflictsWith: key });
        rejected.push({ hu, en: enSeg, fr: frSeg, from: key,
          reason: REJECT.CONFLICT, conflictsWith: seen.from });
        continue;
      }
      const pair = { hu, en: enSeg, fr: frSeg, from: key, parent,
        zones: normalizeZones(zonesByKey[key]) };
      pairs.push(pair);
      byHu.set(hu, pair);
      parent.covered += 1;
      parent.mined += 1;
    }
  }

  // Les paires invalidées par un conflit ne sont plus référencées par byHu.
  // `parent` est un lien interne (cycle) : il ne doit pas sortir du moteur,
  // sinon JSON.stringify du rapport échoue.
  const finalPairs = pairs
    .filter((p) => byHu.get(p.hu) === p)
    .map(({ parent: _parent, ...pair }) => pair);

  // Un parent n'est proposé à la suppression que si CHACUN de ses segments est
  // couvert : miné ici, ou déjà assuré par une clé curée, ou intraduisible par
  // nature. Tout autre motif de refus (littéral trop mince, valeur vide,
  // conflit…) laisse un trou → on garde le parent, sinon on perdrait de la
  // couverture, exactement l'inverse du but.
  const dropParents = parents
    .filter((p) => p.covered === p.segments && p.segments > 0)
    .map((p) => p.key);

  const low = similarities.filter((s) => s.score < LOW_SIMILARITY_THRESHOLD);
  const selfTest = {
    compared: similarities.length,
    lowSimilarity: low.length,
    lowSimilarityRate: similarities.length ? low.length / similarities.length : 0,
    threshold: LOW_SIMILARITY_THRESHOLD,
    maxRate: MAX_LOW_SIMILARITY_RATE,
    ok: similarities.length === 0
      || low.length / similarities.length <= MAX_LOW_SIMILARITY_RATE,
    worst: [...low].sort((a, b) => a.score - b.score).slice(0, 15),
  };

  return {
    pairs: finalPairs,
    rejected,
    unaligned,
    dropParents,
    parents,
    // Sous-ensemble de commodité : les collisions dont la valeur au dico est
    // VIDE (marqueur « non traduit »). Le fragment parent en fournit une
    // traduction, mais on ne remplit jamais automatiquement — une valeur mal
    // zippée y atterrirait sans relecture, et TRANSLATIONS.md peut avoir
    // délibérément écarté cette formulation. Liste à trancher à la main.
    blanks: rejected.filter((r) => r.reason === REJECT.EXISTING_KEY_BLANK),
    selfTest,
    stats: {
      htmlKeys: parents.length + unaligned.length,
      aligned: parents.length,
      unaligned: unaligned.length,
      triples: parents.reduce((n, p) => n + p.segments, 0),
      pairs: finalPairs.length,
      rejected: rejected.length,
      collisions: rejected.filter((r) => r.reason === REJECT.EXISTING_KEY
        || r.reason === REJECT.EXISTING_KEY_BLANK).length,
      dropParents: dropParents.length,
    },
  };
}

// Lignes "zone\tstring" (string échappée), une par zone, triées pour un diff
// stable. build-shards.js les relit via readObserved() et place donc la clé
// dérivée dans le ou les shards du parent.
export function toTsv(pairs) {
  const lines = [];
  for (const pair of pairs) {
    for (const zone of pair.zones) lines.push(`${zone}\t${escapeTsv(pair.hu)}`);
  }
  return [...new Set(lines)].sort();
}

// --- CLI ------------------------------------------------------------------
// Exécuté directement : node tools/mine-html-keys.js
// N'écrit QUE tools/analysis/mined-pairs.json et tools/capture/mined.tsv.
// Ne touche jamais dict/*.json : l'opérateur relit les candidats et les recopie
// à la main dans dict/en.json ET dict/fr.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOG = '[mine-html-keys]';

function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${LOG} JSON invalide dans ${p} : ${e.message}`);
  }
}

// { [clé]: shard[] } depuis dict/en/*.json : c'est le placement RÉEL du parent,
// seule source fiable de sa zone (tools/capture/*.tsv est gitignoré et absent
// d'un clone frais).
function readZonesByKey(dir) {
  const zones = {};
  if (!fs.existsSync(dir)) return zones;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const shard = f.slice(0, -'.json'.length);
    for (const key of Object.keys(readJson(path.join(dir, f), {}))) {
      (zones[key] ||= []).push(shard);
    }
  }
  return zones;
}

// `root` et `logger` injectables pour que les tests travaillent sur une
// arborescence jetable. Ne touche pas à process.exitCode : c'est le wrapper qui
// traduit ok:false en code retour.
export function main({ root = ROOT, logger = console } = {}) {
  const en = readJson(path.join(root, 'dict/en.json'), {});
  const fr = readJson(path.join(root, 'dict/fr.json'), {});
  const enKeys = Object.keys(en);
  const frKeys = Object.keys(fr);
  // Une asymétrie EN/FR casserait l'alignement à trois voies en silence : on
  // préfère abandonner que dériver des paires à moitié fausses.
  if (enKeys.length !== frKeys.length || enKeys.some((k) => !Object.hasOwn(fr, k))) {
    logger.error(`${LOG} ABANDON : dict/en.json (${enKeys.length} clés) et dict/fr.json`
      + ` (${frKeys.length} clés) n'ont pas le même jeu de clés.`);
    return { ok: false, pairs: 0 };
  }

  const zonesByKey = readZonesByKey(path.join(root, 'dict/en'));
  const report = minePairs({ en, fr, zonesByKey });
  const { stats, selfTest } = report;

  const analysisDir = path.join(root, 'tools/analysis');
  fs.mkdirSync(analysisDir, { recursive: true });
  fs.writeFileSync(path.join(analysisDir, 'mined-pairs.json'),
    JSON.stringify({
      pairs: report.pairs,
      rejected: report.rejected,
      unaligned: report.unaligned,
      dropParents: report.dropParents,
      blanks: report.blanks,
      selfTest,
      stats,
    }, null, 2) + '\n');

  // tools/capture/ est gitignoré donc absent d'un clone frais : le créer avant
  // d'écrire, sinon ENOENT.
  const captureDir = path.join(root, 'tools/capture');
  fs.mkdirSync(captureDir, { recursive: true });
  const tsv = toTsv(report.pairs);
  fs.writeFileSync(path.join(captureDir, 'mined.tsv'),
    tsv.length ? tsv.join('\n') + '\n' : '');

  logger.log(`${LOG} clés HTML : ${stats.htmlKeys} | alignées : ${stats.aligned}`
    + ` | non alignées : ${stats.unaligned} | triplets : ${stats.triples}`);
  logger.log(`${LOG} paires dérivées : ${stats.pairs} | refusées : ${stats.rejected}`
    + ` (dont ${stats.collisions} collisions avec une clé existante)`);
  logger.log(`${LOG} parents entièrement couverts (candidats à retirer des shards) :`
    + ` ${stats.dropParents} | collisions à valeur vide à trancher à la main :`
    + ` ${report.blanks.length}`);
  logger.log(`${LOG} auto-test zip : ${selfTest.lowSimilarity}/${selfTest.compared} segments`
    + ` déjà connus sous Jaccard ${selfTest.threshold}`
    + ` (${(selfTest.lowSimilarityRate * 100).toFixed(1)} %)`);
  logger.log(`${LOG} écrit tools/analysis/mined-pairs.json et tools/capture/mined.tsv`
    + ` (${tsv.length} lignes)`);
  // Le TSV seul ne suffit pas : une clé absente de dict/en.json part dans le
  // delta avec une valeur VIDE, ce qui ajouterait des entrées blanches aux
  // shards. L'ordre correct est : relire, patcher les deux dicos, puis builder.
  logger.warn(`${LOG} relire les paires, les recopier dans dict/en.json ET dict/fr.json,`
    + ` PUIS lancer node tools/build-shards.js (jamais l'inverse).`);
  if (!selfTest.ok) {
    logger.error(`${LOG} ABANDON de l'auto-test : ${(selfTest.lowSimilarityRate * 100).toFixed(1)} %`
      + ` de zips manifestement faux (> ${MAX_LOW_SIMILARITY_RATE * 100} %). L'alignement`
      + ` positionnel n'est pas fiable sur ce dico ; ne rien recopier sans relecture ligne à ligne.`);
  }
  return { ok: selfTest.ok, pairs: stats.pairs, stats, selfTest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!main().ok) process.exitCode = 1;
}
