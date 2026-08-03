// tests/mine-html-keys.test.js
// Le moteur de tools/mine-html-keys.js sur des fixtures faites à la main : ce
// sont les seuls garde-fous qui empêchent une paire dérivée fausse (ou une clé
// mal échappée) d'arriver jusqu'à dict/*.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  minePairs, segments, normalizeSegment, escapeTsv, toTsv, hasHtmlMarkup, jaccard, REJECT, main,
} from '../tools/mine-html-keys.js';

// Copie exacte de unescapeTsv() de tools/build-shards.js : le contrat
// d'échappement est vérifié contre CE code, pas contre une intuition.
const unescapeTsv = (s) => s.replace(/\\(.)/g, (_, c) =>
  c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c);

const reasonOf = (report, hu) => report.rejected.find((r) => r.hu === hu)?.reason;
const huOf = (report) => report.pairs.map((p) => p.hu);

// --- segments() -----------------------------------------------------------

test('segments splits a fragment into the text nodes a browser would produce', () => {
  assert.deepEqual(
    segments('Kérjük <strong>frissítsd a jelszavad</strong> mielőbb.'),
    ['Kérjük', 'frissítsd a jelszavad', 'mielőbb.']);
});

test('segments walks nested markup depth-first', () => {
  assert.deepEqual(
    segments('<div>egy<p>kettő <b>három</b> négy</p>öt</div>'),
    ['egy', 'kettő', 'három', 'négy', 'öt']);
});

test('segments treats <br> as a segment boundary', () => {
  assert.deepEqual(segments('első<br>második<br><br>harmadik'),
    ['első', 'második', 'harmadik']);
});

test('segments decodes HTML entities', () => {
  assert.deepEqual(segments('S<b>z&aacute;mla</b> &amp; d&iacute;j'), ['S', 'zámla', '& díj']);
  // &nbsp; est un espace pour \s : il est collapsé comme le fait le runtime.
  assert.deepEqual(segments('1&nbsp;234 Ft'), ['1 234 Ft']);
});

test('segments normalises indentation and newlines the way the runtime does', () => {
  assert.deepEqual(
    segments('<div>\n      Számla\n        kiállítása\n    </div>'),
    ['Számla kiállítása']);
  assert.equal(normalizeSegment('  a \n\t b  '), 'a b');
});

test('segments tolerates truncated extraction garbage without throwing', () => {
  assert.deepEqual(segments('-tól!</strong>\n                    </div>'), ['-tól!']);
  assert.deepEqual(segments('</div>\n<strong>Vége'), ['Vége']);
});

test('segments ignores content of tags the walker never translates', () => {
  assert.deepEqual(segments('Számla<script>var a = "Nem";</script><textarea>Kedves</textarea>'),
    ['Számla']);
});

test('hasHtmlMarkup needs a well-formed tag, not just an angle bracket', () => {
  assert.equal(hasHtmlMarkup('<b>Számla</b>'), true);
  assert.equal(hasHtmlMarkup('Számla <br> díj'), true);
  assert.equal(hasHtmlMarkup('5 < 6 és 7 > 6'), false);
  assert.equal(hasHtmlMarkup('Számlák'), false);
});

// --- alignement ------------------------------------------------------------

test('mines every segment of an aligned three-segment fragment', () => {
  const key = 'Kérjük <strong>frissítsd a jelszavad</strong> mielőbb.';
  const report = minePairs({
    en: { [key]: 'Please <strong>update your password</strong> as soon as possible.' },
    fr: { [key]: 'Merci de <strong>mettre à jour ton mot de passe</strong> au plus vite.' },
  });

  assert.deepEqual(huOf(report), ['Kérjük', 'frissítsd a jelszavad', 'mielőbb.']);
  assert.deepEqual(report.pairs[1],
    { hu: 'frissítsd a jelszavad', en: 'update your password',
      fr: 'mettre à jour ton mot de passe', from: key, zones: ['_common'] });
  assert.deepEqual(report.unaligned, []);
  assert.deepEqual(report.dropParents, [key]);
});

test('reports a fragment whose segment counts diverge and mines nothing from it', () => {
  const key = 'Itt jelennek meg a számláid.<br>Kattints a gombra.';
  const report = minePairs({
    en: { [key]: 'Your invoices will appear here. Click the button.' },
    fr: { [key]: 'Tes factures apparaîtront ici. Clique sur le bouton.' },
  });

  assert.deepEqual(report.pairs, []);
  assert.deepEqual(report.unaligned,
    [{ from: key, hu: 2, en: 1, fr: 1, reason: 'compteurs de segments divergents' }]);
  // Un parent non alignable n'est JAMAIS proposé à la suppression : on perdrait
  // sa couverture sans rien avoir dérivé en échange.
  assert.deepEqual(report.dropParents, []);
});

test('reports a fragment whose parent translation is missing instead of deriving blanks', () => {
  const key = '<b>Számlák</b> listája';
  const report = minePairs({ en: { [key]: '' }, fr: { [key]: '' } });

  assert.deepEqual(report.pairs, []);
  assert.equal(report.unaligned[0].reason, 'traduction parente vide');
  assert.deepEqual(report.dropParents, []);
});

// --- collisions ------------------------------------------------------------

test('an existing dictionary key always wins over the derived value', () => {
  const key = '<strong>Számlák</strong> és díjak listája';
  const report = minePairs({
    en: { 'Számlák': 'Invoices', [key]: '<strong>Bills</strong> and fee list' },
    fr: { 'Számlák': 'Factures', [key]: '<strong>Notes</strong> et liste des frais' },
  });

  assert.equal(reasonOf(report, 'Számlák'), REJECT.EXISTING_KEY);
  assert.deepEqual(huOf(report), ['és díjak listája']);
  // La collision reste couverte par la clé curée : le parent est redondant.
  assert.deepEqual(report.dropParents, [key]);
});

test('a collision is detected through whitespace normalisation too', () => {
  const key = '<b>Számla\n   kiállítása</b> most';
  const report = minePairs({
    en: { 'Számla kiállítása': 'Issue invoice', [key]: '<b>Create invoice</b> now' },
    fr: { 'Számla kiállítása': 'Émettre la facture', [key]: '<b>Créer la facture</b> maintenant' },
  });

  assert.equal(reasonOf(report, 'Számla kiállítása'), REJECT.EXISTING_KEY);
  assert.deepEqual(huOf(report), ['most']);
});

test('a colliding key whose value is blank is flagged for a human, never auto-filled', () => {
  const key = '<b>Készletkezelés</b> alapjai';
  const report = minePairs({
    en: { 'Készletkezelés': '', [key]: '<b>Stock management</b> basics' },
    fr: { 'Készletkezelés': '', [key]: '<b>Gestion des stocks</b> les bases' },
  });

  assert.equal(reasonOf(report, 'Készletkezelés'), REJECT.EXISTING_KEY_BLANK);
  assert.equal(report.pairs.some((p) => p.hu === 'Készletkezelés'), false);
  assert.deepEqual(report.blanks.map((b) => [b.hu, b.en]),
    [['Készletkezelés', 'Stock management']]);
  // Trou de couverture non résolu → on garde le parent.
  assert.deepEqual(report.dropParents, []);
});

// --- filtres par segment ---------------------------------------------------

test('rejects segments that carry no letter', () => {
  const key = '<span>1 234</span> forint összesen';
  const report = minePairs({
    en: { [key]: '<span>1 234</span> forints in total' },
    fr: { [key]: '<span>1 234</span> forints au total' },
  });

  assert.equal(reasonOf(report, '1 234'), REJECT.NO_LETTER);
  assert.deepEqual(huOf(report), ['forint összesen']);
});

test('rejects a bare Laravel token and a token-bearing segment with a thin literal', () => {
  const bare = '<b>:type</b> és a(z) :bankName bankszámla kód';
  const report = minePairs({
    en: { [bare]: '<b>:type</b> and the :bankName bank account code' },
    fr: { [bare]: '<b>:type</b> et le code de compte bancaire :bankName' },
  });

  assert.equal(reasonOf(report, ':type'), REJECT.BARE_TOKEN);
  // 17 lettres littérales hors token → passe le plancher de 8.
  assert.deepEqual(huOf(report), ['és a(z) :bankName bankszámla kód']);

  const thin = '<b>:plan díj</b> most';
  const thinReport = minePairs({
    en: { [thin]: '<b>:plan fee</b> now' },
    fr: { [thin]: '<b>frais :plan</b> maintenant' },
  });
  assert.equal(reasonOf(thinReport, ':plan díj'), REJECT.THIN_TOKEN_LITERAL);
});

test('rejects segments below the minimum length', () => {
  const key = '<b>ok</b> a számla rendben';
  const report = minePairs({
    en: { [key]: '<b>ok</b> the invoice is fine' },
    fr: { [key]: '<b>ok</b> la facture est correcte' },
  });

  assert.equal(reasonOf(report, 'ok'), REJECT.TOO_SHORT);
});

test('rejects identity triples, which would only inflate the coverage percentage', () => {
  const key = '<b>Billingo</b> és a számlázás';
  const report = minePairs({
    en: { [key]: '<b>Billingo</b> and invoicing' },
    fr: { [key]: '<b>Billingo</b> et la facturation' },
  });

  assert.equal(reasonOf(report, 'Billingo'), REJECT.IDENTITY);
  assert.deepEqual(huOf(report), ['és a számlázás']);
});

test('rejects sentence fragments opening on a hyphen or a comma', () => {
  const key = '<b>-ért</b> fizetendő, <i>, és aktiváld a fiókot</i>';
  const report = minePairs({
    en: { [key]: '<b>-for</b> payable, <i>, and activate the account</i>' },
    fr: { [key]: '<b>-pour</b> à payer, <i>, et active le compte</i>' },
  });

  assert.equal(reasonOf(report, '-ért'), REJECT.LEADING_FRAGMENT);
  assert.equal(reasonOf(report, ', és aktiváld a fiókot'), REJECT.LEADING_FRAGMENT);
});

test('rejects markup residue left by a truncated extraction', () => {
  // La balise fermante orpheline est jetée par le parser, donc le résidu
  // d'attribut reste collé au premier nœud texte : c'est bien ce segment-là
  // qu'il faut refuser, et lui seul.
  const key = '" class="font-weight-bold">Megrendelések</a> <b>menüpontban találod</b>';
  const report = minePairs({
    en: { [key]: '" class="font-weight-bold">Orders</a> <b>menu is where you find it</b>' },
    fr: { [key]: '" class="font-weight-bold">Commandes</a> <b>menu est là où tu le trouves</b>' },
  });

  assert.equal(report.rejected[0].reason, REJECT.MARKUP);
  assert.deepEqual(huOf(report), ['menüpontban találod']);
});

test('never emits a pair whose derived translation is empty', () => {
  const key = 'Kérjük <b>erősítsd meg a címet</b>';
  const report = minePairs({
    en: { [key]: 'Please <b></b>' },
    fr: { [key]: 'Merci de <b></b>' },
  });

  // EN/FR perdent le segment : compteurs divergents, donc rien n'est dérivé.
  assert.deepEqual(report.pairs, []);
  assert.equal(report.unaligned.length, 1);
});

// --- zones + TSV -----------------------------------------------------------

test('a derived pair inherits the zones of its parent key', () => {
  const bankKey = '<b>Bankszámla összekötése</b> szükséges';
  const commonKey = '<b>Számlaszám megadása</b> kötelező';
  const report = minePairs({
    en: {
      [bankKey]: '<b>Linking a bank account</b> is required',
      [commonKey]: '<b>Providing an account number</b> is mandatory',
    },
    fr: {
      [bankKey]: '<b>Lier un compte bancaire</b> est nécessaire',
      [commonKey]: '<b>Indiquer un numéro de compte</b> est obligatoire',
    },
    zonesByKey: { [bankKey]: ['bank'], [commonKey]: ['_common', 'bank'] },
  });

  const zonesOf = (hu) => report.pairs.find((p) => p.hu === hu).zones;
  assert.deepEqual(zonesOf('Bankszámla összekötése'), ['bank']);
  // _common gagne sur les shards de zone, comme dans build-shards.js.
  assert.deepEqual(zonesOf('Számlaszám megadása'), ['_common']);
});

test('TSV lines survive the round trip through build-shards unescapeTsv', () => {
  const raw = 'a\\b\tc\nd\re';
  assert.equal(unescapeTsv(escapeTsv(raw)), raw);
  assert.equal(escapeTsv(raw), 'a\\\\b\\tc\\nd\\re');

  const pairs = [{ hu: 'C:\\Számla', en: 'x', fr: 'y', zones: ['bank', '_common'] }];
  const lines = toTsv(pairs);
  assert.deepEqual(lines.map((l) => l.split('\t')[0]).sort(), ['_common', 'bank']);
  for (const line of lines) {
    assert.equal(unescapeTsv(line.slice(line.indexOf('\t') + 1)), 'C:\\Számla');
  }
});

// --- conflits + auto-test --------------------------------------------------

test('two parents deriving the same HU differently invalidate each other', () => {
  const a = '<b>Elfogadom</b> a feltételeket';
  const b = '<i>Elfogadom</i> az adatvédelmi tájékoztatót';
  const report = minePairs({
    en: { [a]: '<b>I accept</b> the terms', [b]: '<i>I agree to</i> the privacy notice' },
    fr: { [a]: "<b>J'accepte</b> les conditions", [b]: "<i>Je consens à</i> l'avis de confidentialité" },
  });

  assert.equal(report.pairs.some((p) => p.hu === 'Elfogadom'), false);
  assert.equal(report.rejected.filter((r) => r.reason === REJECT.CONFLICT).length, 2);
  // Les deux parents gardent un trou → aucun n'est proposé à la suppression.
  assert.deepEqual(report.dropParents, []);
});

test('two parents deriving the same HU identically merge their zones', () => {
  const a = '<b>Számla kiállítása</b> most';
  const b = '<i>Számla kiállítása</i> később';
  const report = minePairs({
    en: { [a]: '<b>Issue invoice</b> now', [b]: '<i>Issue invoice</i> later' },
    fr: { [a]: '<b>Émettre la facture</b> maintenant', [b]: '<i>Émettre la facture</i> plus tard' },
    zonesByKey: { [a]: ['documents'], [b]: ['subscription'] },
  });

  const pair = report.pairs.find((p) => p.hu === 'Számla kiállítása');
  assert.deepEqual(pair.zones, ['documents', 'subscription']);
  assert.equal(report.rejected.filter((r) => r.reason === REJECT.CONFLICT).length, 0);
});

test('the self-test flags a mis-zipped derivation against a curated key', () => {
  const key = '<b>Számlák</b> és <i>korlátlan</i> felhasználók';
  const report = minePairs({
    en: {
      'Számlák': 'Invoices',
      'korlátlan': 'unlimited',
      [key]: '<b>unlimited</b> and <i>Invoices</i> users',
    },
    fr: {
      'Számlák': 'Factures',
      'korlátlan': 'illimité',
      [key]: '<b>illimité</b> et <i>Factures</i> utilisateurs',
    },
  });

  // Les deux segments sont des clés connues, et les deux valeurs sont permutées.
  assert.equal(report.selfTest.compared, 2);
  assert.equal(report.selfTest.lowSimilarity, 2);
  assert.equal(report.selfTest.ok, false);
  assert.equal(report.selfTest.worst[0].hu, 'Számlák');
});

test('jaccard separates a paraphrase from a swapped value', () => {
  assert.ok(jaccard('Issue invoice', 'Create invoice') > 0.2);
  assert.equal(jaccard('Invoices', 'unlimited'), 0);
});

test('the report never silently drops a segment', () => {
  const key = '<b>1 234</b> Ft, <i>ok</i>, <u>fizetendő összeg</u>';
  const report = minePairs({
    en: { [key]: '<b>1 234</b> HUF, <i>ok</i>, <u>amount payable</u>' },
    fr: { [key]: '<b>1 234</b> HUF, <i>ok</i>, <u>montant à payer</u>' },
  });

  const parent = report.parents.find((p) => p.key === key);
  assert.equal(report.pairs.length + report.rejected.length, parent.segments);
});

// --- CLI ------------------------------------------------------------------

test('main writes the review file and the TSV without touching dict JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-html-'));
  const key = 'Kérjük <strong>frissítsd a jelszavad</strong> mielőbb.';
  const en = { [key]: 'Please <strong>update your password</strong> as soon as possible.' };
  const fr = { [key]: 'Merci de <strong>mettre à jour ton mot de passe</strong> au plus vite.' };
  fs.mkdirSync(path.join(root, 'dict/en'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dict/en.json'), JSON.stringify(en));
  fs.writeFileSync(path.join(root, 'dict/fr.json'), JSON.stringify(fr));
  fs.writeFileSync(path.join(root, 'dict/en/subscription.json'), JSON.stringify(en));
  const before = fs.readFileSync(path.join(root, 'dict/en.json'), 'utf8');
  const logger = { log() {}, warn() {}, error() {} };

  const result = main({ root, logger });

  assert.equal(result.ok, true);
  assert.equal(result.pairs, 3);
  assert.equal(fs.readFileSync(path.join(root, 'dict/en.json'), 'utf8'), before);
  const report = JSON.parse(
    fs.readFileSync(path.join(root, 'tools/analysis/mined-pairs.json'), 'utf8'));
  assert.equal(report.pairs.length, 3);
  assert.deepEqual(report.dropParents, [key]);
  const tsv = fs.readFileSync(path.join(root, 'tools/capture/mined.tsv'), 'utf8')
    .split('\n').filter(Boolean);
  assert.equal(tsv.length, 3);
  // La zone du parent (subscription) est reportée sur chaque clé dérivée.
  assert.deepEqual([...new Set(tsv.map((l) => l.split('\t')[0]))], ['subscription']);
  assert.deepEqual(tsv.map((l) => unescapeTsv(l.split('\t')[1])).sort(),
    ['Kérjük', 'frissítsd a jelszavad', 'mielőbb.'].sort());

  fs.rmSync(root, { recursive: true, force: true });
});

test('main bails out when EN and FR key sets differ', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-html-'));
  fs.mkdirSync(path.join(root, 'dict'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dict/en.json'), JSON.stringify({ '<b>A</b> számla': 'x' }));
  fs.writeFileSync(path.join(root, 'dict/fr.json'), JSON.stringify({}));
  const errors = [];
  const logger = { log() {}, warn() {}, error: (m) => errors.push(m) };

  const result = main({ root, logger });

  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(path.join(root, 'tools/analysis/mined-pairs.json')), false);
  assert.match(errors[0], /ABANDON/);

  fs.rmSync(root, { recursive: true, force: true });
});
