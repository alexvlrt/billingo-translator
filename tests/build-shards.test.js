import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planShards, baselineObserved, mergeObserved, diffShardSets, countByShard,
  countTranslated, diffTranslations, MAX_TRANSLATION_LOSS_RATIO, main,
} from '../tools/build-shards.js';
import { makeHuFilter, looksLikeNoise, hasHtmlMarkup, CHROME_STRINGS, COMMON_ZONE_THRESHOLD }
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

// --- rejet persistant + balises HTML : garde-fous de la découverte ---------

test('rejet persistant : un candidat nouveau listé est écarté', () => {
  const observed = { 'Tháng 1': ['documents'], 'Számla': ['documents'] };
  const rejected = new Set(['Tháng 1']);
  const { placement, delta } = planShards(observed, new Set(), { ...opts(), rejected });

  assert.equal(placement.has('Tháng 1'), false);
  assert.equal(delta.has('Tháng 1'), false);
  assert.ok(placement.has('Számla'), 'les autres candidats passent');
});

test('rejet persistant : une clé DÉJÀ au dico reste maîtresse', () => {
  // dict/en.json est la source de vérité pour l'existence : la liste de rejet ne
  // sert qu'à empêcher une RÉINTRODUCTION par la capture.
  const rejected = new Set(['Számla']);
  const { placement } = planShards({}, new Set(['Számla']), { ...opts(), rejected });
  assert.ok(placement.has('Számla'));
});

test('balises HTML : un candidat nouveau porteur de balises est écarté', () => {
  // Rendu par v-html, donc jamais un nœud texte : la clé ne peut jamais matcher.
  const observed = {
    '<b>Biztosan törlöd?</b>': ['documents'],
    'Biztosan törlöd?': ['documents'],
  };
  const { placement } = planShards(observed, new Set(), { ...opts(), hasHtmlMarkup });

  assert.equal(placement.has('<b>Biztosan törlöd?</b>'), false);
  assert.ok(placement.has('Biztosan törlöd?'), 'le fragment détagué, lui, est gardé');
});

test('CLI : dict/_rejected.json empêche la capture de ressusciter le déchet', (t) => {
  const root = makeTree(t, { shards: SAMPLE, tsv: { 'a.tsv': 'documents\tTháng 1\ndocuments\tÚj szűrő\n' } });
  fs.writeFileSync(path.join(root, 'dict/_rejected.json'),
    JSON.stringify({ rejected: { 'Tháng 1': 'foreign-locale' } }, null, 2));

  const res = main({ root, argv: [], logger: silentLogger() });

  assert.equal(res.ok, true);
  const en = JSON.parse(fs.readFileSync(path.join(root, 'dict/en.json'), 'utf8'));
  assert.equal('Tháng 1' in en, false, 'rejeté, donc jamais réintroduit');
  assert.ok('Új szűrő' in en, 'la vraie découverte passe toujours');
});

// --- baselineObserved : reconstruction depuis les shards du disque ---------

test('baseline : chaque clé d’un shard de zone est observée dans cette zone', () => {
  const observed = baselineObserved({
    _common: ['Általános'],
    documents: ['Számla', 'Tétel hozzáadása'],
    partners: ['Számla'],
  });
  assert.deepEqual(observed['Számla'].sort(), ['documents', 'partners']);
  assert.deepEqual(observed['Tétel hozzáadása'], ['documents']);
});

test('baseline : clé présente seulement dans _common → aucune zone → replacée dans _common', () => {
  const observed = baselineObserved({ _common: ['Általános'], documents: ['Számla'] });
  assert.deepEqual(observed['Általános'], []);
  const { placement } = planShards(observed, new Set(['Általános', 'Számla']),
    opts(new Set(['Általános', 'Számla'])));
  assert.deepEqual([...placement.get('Általános')], ['_common']);
  assert.deepEqual([...placement.get('Számla')], ['documents']);
});

test('baseline : clé dans _common ET dans un shard de zone → _common gagne', () => {
  // Cas réel des shards commités : « Dátum » vit dans _common (chargé partout)
  // et est dupliqué dans bank.json. Lire bank.json le sortirait de _common et
  // régresserait la couverture sur toutes les autres routes.
  const observed = baselineObserved({ _common: ['Dátum'], bank: ['Dátum', 'Bankszámla'] });
  assert.deepEqual(observed['Dátum'], []);
  assert.deepEqual(observed['Bankszámla'], ['bank']);
});

test('baseline : dossier de shards vide → aucune observation', () => {
  assert.deepEqual(baselineObserved({}), {});
});

test('baseline : une clé absente de la source de vérité est écartée', () => {
  // Les shards sont notre propre sortie : ils prouvent OÙ une clé a été vue,
  // jamais QU’elle existe encore. Sans ce filtre une clé supprimée de
  // dict/en.json ressuscite depuis le shard écrit au run précédent.
  const shards = { _common: ['Általános', 'Adószám'], bank: ['Bankszámla', 'Adószám'] };
  const observed = baselineObserved(shards, new Set(['Általános', 'Bankszámla']));
  assert.deepEqual(Object.keys(observed).sort(), ['Bankszámla', 'Általános']);
  assert.equal(Object.hasOwn(observed, 'Adószám'), false);
});

test('baseline : clé connue seulement de dict/fr.json → placement conservé', () => {
  // knownKeys est l’UNION des deux dicos : une clé traduite d’un seul côté ne
  // doit pas perdre sa zone.
  const observed = baselineObserved({ bank: ['Bankszámla'] }, new Set(['Bankszámla']));
  assert.deepEqual(observed['Bankszámla'], ['bank']);
});

// --- mergeObserved : précédence par clé -----------------------------------

test('overlay : les zones TSV d’une clé remplacent ses zones baseline', () => {
  const merged = mergeObserved(
    { 'Számla': ['documents'], 'Általános': [] },
    { 'Számla': ['partners'], 'Általános': ['bank'] });
  assert.deepEqual(merged['Számla'], ['partners']);
  // Une capture fraîche doit pouvoir faire sortir une clé de _common.
  assert.deepEqual(merged['Általános'], ['bank']);
});

test('overlay : clé absente du TSV → garde ses zones baseline', () => {
  const merged = mergeObserved({ 'Bankszámla': ['bank'] }, { 'Számla': ['documents'] });
  assert.deepEqual(merged['Bankszámla'], ['bank']);
  assert.deepEqual(merged['Számla'], ['documents']);
});

test('overlay : une capture partielle n’effondre pas le reste dans _common', () => {
  const baseline = baselineObserved({
    _common: ['Általános'],
    documents: ['Számla'],
    partners: ['Partner adószáma'],
    bank: ['Bankszámla'],
  });
  const keys = new Set(Object.keys(baseline));
  // Un seul .tsv, une seule route balayée : tout le reste doit survivre.
  const { placement } = planShards(
    mergeObserved(baseline, { 'Számla': ['partners'] }), keys, opts(keys));
  assert.deepEqual([...placement.get('Számla')], ['partners']);
  assert.deepEqual([...placement.get('Partner adószáma')], ['partners']);
  assert.deepEqual([...placement.get('Bankszámla')], ['bank']);
  assert.deepEqual([...placement.get('Általános')], ['_common']);
});

test('overlay : ne mute ni la baseline ni les captures', () => {
  const baseline = { 'Számla': ['documents'] };
  const captured = { 'Számla': ['partners'] };
  mergeObserved(baseline, captured);
  assert.deepEqual(baseline, { 'Számla': ['documents'] });
  assert.deepEqual(captured, { 'Számla': ['partners'] });
});

// --- diffShardSets / countByShard -----------------------------------------

test('diffShardSets : détecte le rétrécissement, l’ajout et la suppression', () => {
  const shrink = diffShardSets(new Set(['_common', 'bank']), new Set(['_common']));
  assert.deepEqual(shrink, { removed: ['bank'], added: [], isShrinking: true });
  const grow = diffShardSets(new Set(['_common']), new Set(['_common', 'tax']));
  assert.deepEqual(grow, { removed: [], added: ['tax'], isShrinking: false });
  // Renommage à nombre constant : pas un rétrécissement, mais on le signale.
  const rename = diffShardSets(new Set(['bank']), new Set(['tax']));
  assert.deepEqual(rename, { removed: ['bank'], added: ['tax'], isShrinking: false });
});

test('countByShard : compte les clés par shard, doublons de zones inclus', () => {
  const placement = new Map([
    ['a', new Set(['documents', 'partners'])],
    ['b', new Set(['documents'])],
  ]);
  assert.deepEqual(countByShard(placement), { documents: 2, partners: 1 });
});

// --- countTranslated / diffTranslations -----------------------------------

test('countTranslated : compte les clés distinctes non vides, doublons de shards exclus', () => {
  const shards = {
    _common: { 'Dátum': 'Date', 'Adószám': '' },
    bank: { 'Dátum': 'Date', 'Bankszámla': 'Bank account' },
  };
  // « Dátum » est dans deux shards mais ne compte qu’une fois ; « Adószám » n’est
  // pas traduit (valeur vide = miss, jamais une traduction).
  assert.equal(countTranslated(shards), 2);
  assert.equal(countTranslated({}), 0);
  assert.equal(countTranslated({ _common: { 'Adószám': '' } }), 0);
});

test('diffTranslations : tolère une purge d’hygiène, refuse un effacement', () => {
  // 40 clés perdues sur 8 000 (0,5 %) : purge normale, ça passe.
  const purge = diffTranslations({ en: 8000, fr: 8000 }, { en: 7960, fr: 7960 });
  assert.deepEqual(purge, { lost: [], isLosing: false });
  // Une langue entière vidée : ça casse, et le rapport nomme la langue.
  const wipe = diffTranslations({ en: 8000, fr: 8000 }, { en: 8000, fr: 0 });
  assert.equal(wipe.isLosing, true);
  assert.deepEqual(wipe.lost, [{ lang: 'fr', before: 8000, after: 0, allowed: 800 }]);
  // Croissance : jamais une perte.
  assert.equal(diffTranslations({ en: 10, fr: 10 }, { en: 460, fr: 460 }).isLosing, false);
});

test('diffTranslations : le seuil est proportionnel et vaut 10 %', () => {
  assert.equal(MAX_TRANSLATION_LOSS_RATIO, 0.10);
  const atLimit = diffTranslations({ en: 1000, fr: 1000 }, { en: 900, fr: 1000 });
  assert.equal(atLimit.isLosing, false);
  const overLimit = diffTranslations({ en: 1000, fr: 1000 }, { en: 899, fr: 1000 });
  assert.equal(overLimit.isLosing, true);
});

// --- CLI de bout en bout sur une arborescence jetable ----------------------

function silentLogger() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { log: push, warn: push, error: push, lines };
}

// Écrit un dict/ minimal : { en: {shard: {hu: trad}}, tsv: {fichier: contenu} }.
function makeTree(t, { shards, tsv }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-shards-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const flat = {};
  for (const obj of Object.values(shards)) Object.assign(flat, obj);
  for (const lang of ['en', 'fr']) {
    fs.mkdirSync(path.join(root, 'dict', lang), { recursive: true });
    fs.writeFileSync(path.join(root, `dict/${lang}.json`), JSON.stringify(flat, null, 2));
    for (const [shard, obj] of Object.entries(shards)) {
      fs.writeFileSync(path.join(root, `dict/${lang}/${shard}.json`), JSON.stringify(obj, null, 2));
    }
  }
  if (tsv) {
    fs.mkdirSync(path.join(root, 'tools/capture'), { recursive: true });
    for (const [f, content] of Object.entries(tsv)) {
      fs.writeFileSync(path.join(root, 'tools/capture', f), content);
    }
  }
  return root;
}

function readShard(root, lang, shard) {
  return JSON.parse(fs.readFileSync(path.join(root, `dict/${lang}/${shard}.json`), 'utf8'));
}

const SAMPLE = {
  _common: { 'Általános': 'General' },
  documents: { 'Számla': 'Invoice', 'Tétel hozzáadása': 'Add item' },
  partners: { 'Partner adószáma': 'Partner tax number' },
  bank: { 'Bankszámla': 'Bank account' },
};

test('CLI sans aucune capture : reproduit le découpage du disque, index non vide', (t) => {
  const root = makeTree(t, { shards: SAMPLE });
  const logger = silentLogger();
  const res = main({ root, argv: [], logger });

  assert.equal(res.ok, true);
  assert.equal(res.shards, 4);
  assert.deepEqual(res.removed, []);
  assert.deepEqual(res.added, []);
  assert.deepEqual(fs.readdirSync(path.join(root, 'dict/en')).sort(),
    ['_common.json', 'bank.json', 'documents.json', 'partners.json']);
  for (const [shard, obj] of Object.entries(SAMPLE)) {
    assert.deepEqual(readShard(root, 'en', shard), obj, `shard ${shard} inchangé`);
    assert.deepEqual(Object.keys(readShard(root, 'fr', shard)), Object.keys(obj));
  }
  // Le loader runtime est mort si l’index est vide.
  const index = JSON.parse(fs.readFileSync(path.join(root, 'dict/_index.json'), 'utf8'));
  assert.ok(index.length > 0);
  assert.ok(index.some((e) => e.shard === 'documents'));
  assert.equal(index.some((e) => e.shard === '_common'), false);
});

test('CLI : tools/capture/ absent est créé, pas d’ENOENT sur delta.json', (t) => {
  const root = makeTree(t, { shards: SAMPLE });
  assert.equal(fs.existsSync(path.join(root, 'tools/capture')), false);
  const res = main({ root, argv: [], logger: silentLogger() });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(root, 'tools/capture/delta.json')));
  assert.ok(fs.existsSync(path.join(root, 'tools/capture/observed.json')));
});

test('CLI : une clé ajoutée au seul dict/fr.json n’est pas effacée', (t) => {
  // existingKeys était `en` seul, donc la clé sortait du plan ; comme les
  // monolithiques sont réécrits DEPUIS le plan, la traduction française
  // disparaissait en silence — et le garde-fou sur les valeurs ne voyait rien,
  // la clé n’étant ni dans les shards d’avant ni dans ceux d’après.
  const root = makeTree(t, { shards: SAMPLE });
  const frPath = path.join(root, 'dict/fr.json');
  const fr = JSON.parse(fs.readFileSync(frPath, 'utf8'));
  fr['Áfa nélküli összeg'] = 'Montant hors TVA';
  fs.writeFileSync(frPath, JSON.stringify(fr, null, 2));

  const res = main({ root, argv: [], logger: silentLogger() });

  assert.equal(res.ok, true);
  const after = JSON.parse(fs.readFileSync(frPath, 'utf8'));
  assert.equal(after['Áfa nélküli összeg'], 'Montant hors TVA');
  // Sans zone observée, elle atterrit dans _common — et pas dans le néant.
  assert.equal(readShard(root, 'fr', '_common')['Áfa nélküli összeg'], 'Montant hors TVA');
});

test('CLI : ni shard sur disque ni capture → ABANDON, angle mort des deux gardes', (t) => {
  // `isShrinking` compare des tailles (n < 0 est faux) et la perte de traductions
  // part de 0 : les deux gardes se taisent alors que c’est le cas le plus
  // destructeur — tout retombe dans _common et _index.json perd ses routes.
  const root = makeTree(t, { shards: SAMPLE });
  for (const lang of ['en', 'fr']) {
    fs.rmSync(path.join(root, 'dict', lang), { recursive: true, force: true });
  }
  const logger = silentLogger();
  const res = main({ root, argv: [], logger });

  assert.equal(res.ok, false);
  assert.match(logger.lines.join('\n'), /\[build-shards\] ABANDON : aucun shard/);
  assert.equal(fs.existsSync(path.join(root, 'dict/en')), false, 'rien n’a été écrit');
});

test('CLI : --allow-shrink force malgré l’absence de shards et de capture', (t) => {
  const root = makeTree(t, { shards: SAMPLE });
  for (const lang of ['en', 'fr']) {
    fs.rmSync(path.join(root, 'dict', lang), { recursive: true, force: true });
  }
  const res = main({ root, argv: ['--allow-shrink'], logger: silentLogger() });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(root, 'dict/en/_common.json')));
});

test('CLI : idempotent, un second run ne change plus rien', (t) => {
  const root = makeTree(t, { shards: SAMPLE });
  main({ root, argv: [], logger: silentLogger() });
  const snapshot = fs.readdirSync(path.join(root, 'dict/en'))
    .map((f) => [f, fs.readFileSync(path.join(root, 'dict/en', f), 'utf8')]);
  main({ root, argv: [], logger: silentLogger() });
  for (const [f, content] of snapshot) {
    assert.equal(fs.readFileSync(path.join(root, 'dict/en', f), 'utf8'), content, f);
  }
});

test('CLI : capture partielle → seule la clé revue bouge, rien ne tombe dans _common', (t) => {
  const root = makeTree(t, {
    shards: SAMPLE,
    tsv: { 'sweep.tsv': 'partners\tSzámla\n' },
  });
  const res = main({ root, argv: [], logger: silentLogger() });

  assert.equal(res.ok, true);
  // La clé revue prend ses zones TSV…
  assert.deepEqual(Object.keys(readShard(root, 'en', 'partners')).sort(),
    ['Partner adószáma', 'Számla']);
  assert.deepEqual(Object.keys(readShard(root, 'en', 'documents')), ['Tétel hozzáadása']);
  // …et tout ce que le TSV ignore garde sa place.
  assert.deepEqual(readShard(root, 'en', 'bank'), { 'Bankszámla': 'Bank account' });
  assert.deepEqual(readShard(root, 'en', '_common'), { 'Általános': 'General' });
});

test('CLI : une capture peut faire sortir une clé de _common', (t) => {
  const root = makeTree(t, {
    shards: {
      _common: { 'Általános': 'General', 'Egyéb': 'Other' },
      bank: { 'Bankszámla': 'Bank account' },
    },
    tsv: { 'sweep.tsv': 'bank\tÁltalános\n' },
  });
  const res = main({ root, argv: [], logger: silentLogger() });

  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(readShard(root, 'en', '_common')), ['Egyéb']);
  assert.deepEqual(Object.keys(readShard(root, 'en', 'bank')).sort(),
    ['Bankszámla', 'Általános']);
});

// Arborescence qui perdrait un shard : « Stripe Connect » n’est pas dans
// dict/en.json et n’a pas de diacritique hongrois → filtré → bank.json vidé.
const SHRINKING = {
  shards: {
    _common: { 'Általános': 'General' },
    bank: { 'Stripe Connect': '' },
  },
};

test('CLI : le garde-fou refuse d’écrire moins de shards qu’il n’en existe', (t) => {
  const root = makeTree(t, SHRINKING);
  fs.writeFileSync(path.join(root, 'dict/en.json'),
    JSON.stringify({ 'Általános': 'General' }, null, 2));
  fs.writeFileSync(path.join(root, 'dict/fr.json'),
    JSON.stringify({ 'Általános': 'Général' }, null, 2));
  const logger = silentLogger();

  const res = main({ root, argv: [], logger });

  assert.equal(res.ok, false);
  assert.deepEqual(res.removed, ['bank']);
  const message = logger.lines.join('\n');
  assert.match(message, /\[build-shards\] ABANDON/);
  assert.match(message, /bank/);
  assert.match(message, /--allow-shrink/);
  // Rien n’a été écrit : le shard est intact et l’index n’a pas été créé.
  assert.deepEqual(readShard(root, 'en', 'bank'), { 'Stripe Connect': '' });
  assert.equal(fs.existsSync(path.join(root, 'dict/_index.json')), false);
});

test('CLI : --allow-shrink contourne le garde-fou', (t) => {
  const root = makeTree(t, SHRINKING);
  fs.writeFileSync(path.join(root, 'dict/en.json'),
    JSON.stringify({ 'Általános': 'General' }, null, 2));
  fs.writeFileSync(path.join(root, 'dict/fr.json'),
    JSON.stringify({ 'Általános': 'Général' }, null, 2));

  const res = main({ root, argv: ['--allow-shrink'], logger: silentLogger() });

  assert.equal(res.ok, true);
  assert.deepEqual(res.removed, ['bank']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'dict/en')), ['_common.json']);
});

test('CLI : le résumé avant/après est imprimé à chaque run, traductions comprises', (t) => {
  const root = makeTree(t, { shards: SAMPLE });
  const logger = silentLogger();
  main({ root, argv: [], logger });
  const message = logger.lines.join('\n');
  assert.match(message, /\[build-shards\] avant : 4 shards, 5 entrées, traduites en 5 \/ fr 5/);
  assert.match(message, /\[build-shards\] après : 4 shards, 5 entrées, traduites en 5 \/ fr 5/);
  assert.match(message, /aucun shard modifié/);
});

// --- Suppression de clés et garde-fou sur les valeurs ----------------------
// Ces cas ont besoin d’un dico assez gros : le seuil de perte est proportionnel
// (10 %), donc sur un arbre de 5 clés le moindre retrait le déclencherait.

function huKeys(n, offset = 0) {
  const obj = {};
  for (let i = 0; i < n; i += 1) obj[`Számla tétel ${offset + i}`] = `Invoice item ${offset + i}`;
  return obj;
}

const BIG = { _common: huKeys(40), documents: huKeys(20, 100) };

function flatten(shards) {
  return Object.assign({}, ...Object.values(shards));
}

function writeDicts(root, obj) {
  for (const lang of ['en', 'fr']) {
    fs.writeFileSync(path.join(root, `dict/${lang}.json`), JSON.stringify(obj, null, 2));
  }
}

function readDict(root, lang) {
  return JSON.parse(fs.readFileSync(path.join(root, `dict/${lang}.json`), 'utf8'));
}

test('CLI : une clé supprimée de la source de vérité ne ressuscite pas, ni au 2e run', (t) => {
  const root = makeTree(t, { shards: BIG });
  const purged = flatten(BIG);
  delete purged['Számla tétel 0'];   // vivait dans _common
  delete purged['Számla tétel 100']; // vivait dans documents
  writeDicts(root, purged);
  const gone = ['Számla tétel 0', 'Számla tétel 100'];

  // Deux runs : le premier ré-écrit les shards, le second les relit. C’est là
  // que la baseline auto-entretenue ressuscitait la clé avec une valeur vide.
  for (const pass of [1, 2]) {
    const res = main({ root, argv: [], logger: silentLogger() });
    assert.equal(res.ok, true, `run ${pass} doit réussir`);
    for (const lang of ['en', 'fr']) {
      const mono = readDict(root, lang);
      const shards = { _common: readShard(root, lang, '_common'),
        documents: readShard(root, lang, 'documents') };
      for (const hu of gone) {
        assert.equal(Object.hasOwn(mono, hu), false, `${lang}.json / run ${pass} : ${hu}`);
        assert.equal(Object.hasOwn(shards._common, hu), false, `${lang}/_common / run ${pass}`);
        assert.equal(Object.hasOwn(shards.documents, hu), false, `${lang}/documents / run ${pass}`);
      }
    }
    // …et elle ne réapparaît pas non plus comme « à traduire ».
    const delta = JSON.parse(fs.readFileSync(path.join(root, 'tools/capture/delta.json'), 'utf8'));
    const toTranslate = Object.values(delta).flat();
    for (const hu of gone) assert.equal(toTranslate.includes(hu), false, `delta / run ${pass}`);
  }
});

test('CLI : dict/fr.json vidé → ABANDON, aucune traduction écrasée', (t) => {
  const root = makeTree(t, { shards: BIG });
  fs.writeFileSync(path.join(root, 'dict/fr.json'), '{}');
  const logger = silentLogger();

  const res = main({ root, argv: [], logger });

  assert.equal(res.ok, false);
  // Le nombre de shards, lui, ne bouge pas : c’est exactement l’angle mort que
  // diffShardSets laissait passer avec un « aucun shard modifié » rassurant.
  assert.deepEqual(res.removed, []);
  assert.deepEqual(res.lost, [{ lang: 'fr', before: 60, after: 0, allowed: 6 }]);
  const message = logger.lines.join('\n');
  assert.match(message, /\[build-shards\] ABANDON : ce run détruirait des traductions fr : 60 → 0/);
  assert.match(message, /--allow-shrink/);
  assert.match(message, /traduites en 60 \/ fr 0/);
  // Rien n’a été écrit : les shards français gardent leurs valeurs.
  assert.equal(readShard(root, 'fr', '_common')['Számla tétel 0'], 'Invoice item 0');
  assert.equal(fs.existsSync(path.join(root, 'dict/_index.json')), false);
  assert.deepEqual(readDict(root, 'fr'), {});
});

test('CLI : dict/en.json vidé → ABANDON, le français survit', (t) => {
  const root = makeTree(t, { shards: BIG });
  fs.writeFileSync(path.join(root, 'dict/en.json'), '{}');
  const logger = silentLogger();

  const res = main({ root, argv: [], logger });

  assert.equal(res.ok, false);
  assert.deepEqual(res.lost, [{ lang: 'en', before: 60, after: 0, allowed: 6 }]);
  assert.match(logger.lines.join('\n'), /ABANDON : ce run détruirait des traductions en : 60 → 0/);
  assert.equal(readShard(root, 'fr', 'documents')['Számla tétel 100'], 'Invoice item 100');
  assert.equal(readShard(root, 'en', 'documents')['Számla tétel 100'], 'Invoice item 100');
});

test('CLI : purge de quelques clés mortes + ajouts massifs passe sans flag', (t) => {
  const root = makeTree(t, { shards: BIG });
  const next = flatten(BIG);
  for (const hu of ['Számla tétel 1', 'Számla tétel 2', 'Számla tétel 101']) delete next[hu];
  const added = huKeys(20, 500);
  writeDicts(root, { ...next, ...added });

  const res = main({ root, argv: [], logger: silentLogger() });

  assert.equal(res.ok, true);
  assert.deepEqual(res.lost, []);
  assert.deepEqual(res.translated.after, { en: 77, fr: 77 }); // 60 − 3 + 20
  // Les nouveautés atterrissent dans _common (aucune zone observée) et sont
  // annoncées comme déjà traduites, donc hors delta.
  const common = readShard(root, 'en', '_common');
  assert.equal(common['Számla tétel 500'], 'Invoice item 500');
  assert.equal(Object.hasOwn(common, 'Számla tétel 1'), false);
  assert.equal(Object.hasOwn(readShard(root, 'en', 'documents'), 'Számla tétel 101'), false);
});

test('CLI : --allow-shrink contourne aussi le garde-fou sur les traductions', (t) => {
  const root = makeTree(t, { shards: BIG });
  fs.writeFileSync(path.join(root, 'dict/fr.json'), '{}');

  const res = main({ root, argv: ['--allow-shrink'], logger: silentLogger() });

  assert.equal(res.ok, true);
  assert.deepEqual(res.translated.after, { en: 60, fr: 0 });
  // Valeur vide = miss côté runtime : la clé reste, le hongrois reste visible.
  assert.deepEqual(new Set(Object.values(readShard(root, 'fr', '_common'))), new Set(['']));
  assert.equal(readShard(root, 'en', '_common')['Számla tétel 0'], 'Invoice item 0');
});
