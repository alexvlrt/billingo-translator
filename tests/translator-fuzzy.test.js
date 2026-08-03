// tests/translator-fuzzy.test.js
// The fallback layers that run after an exact-match miss: whitespace
// normalisation, trailing-punctuation stripping, case variants, pattern matching
// (Laravel-style :tokens and numeric templates), and the two composite layers
// (parenthetical tail, separator split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBillingoTranslator } from './load-script.js';

const { createTranslator } = loadBillingoTranslator('src/translator.js');

// --- Layer 2: whitespace normalisation -------------------------------------

test('collapses internal whitespace runs before lookup', () => {
  const t = createTranslator({ 'Új tétel hozzáadása': 'Ajouter une ligne' });
  assert.equal(t('Új  tétel\n        hozzáadása'), 'Ajouter une ligne');
});

test('treats a non-breaking space as whitespace', () => {
  const t = createTranslator({ 'Fizetési határidő': 'Échéance' });
  assert.equal(t('Fizetési határidő'), 'Échéance');
});

// --- Layer 3: trailing punctuation -----------------------------------------

test('matches a label that the DOM renders with a trailing colon', () => {
  const t = createTranslator({ 'Adószám': 'Numéro fiscal' });
  assert.equal(t('Adószám:'), 'Numéro fiscal:');
});

test('matches a label carrying a required-field marker', () => {
  const t = createTranslator({ 'Megjegyzés': 'Remarque' });
  assert.equal(t('Megjegyzés *'), 'Remarque *');
});

test('an exact key wins over the punctuation-stripped one', () => {
  const t = createTranslator({ 'Összesen:': 'Total TTC :', 'Összesen': 'Total' });
  assert.equal(t('Összesen:'), 'Total TTC :');
});

test('strips sentence punctuation a toast adds to a known label', () => {
  // The read-only crawlers cannot reach toasts and validation errors, so the
  // dictionary holds the bare label far more often than the shouted variant.
  const t = createTranslator({
    'Figyelem': 'Attention',
    'Hogyan működik': 'Comment ça marche',
    'Folyamatban': 'En cours',
    'Éves': 'Annuel',
  });
  assert.equal(t('Figyelem!'), 'Attention!');
  assert.equal(t('Hogyan működik?'), 'Comment ça marche?');
  assert.equal(t('Folyamatban...'), 'En cours...');
  assert.equal(t('Éves,'), 'Annuel,');
});

test('a core with no letter is never stripped down to a match', () => {
  // A Hungarian ordinal or a percentage must not lose its trailing dot and match
  // whatever the digits alone happen to resolve to.
  const t = createTranslator({ '1': 'un', '27%': '27 %' });
  assert.equal(t('1.'), null);
  assert.equal(t('27%.'), null);
});

test('an abbreviation that is itself a key keeps its dot', () => {
  const t = createTranslator({ 'pl.': 'e.g.', 'pl': 'nope' });
  assert.equal(t('pl.'), 'e.g.');
});

// --- Layer 3 in French: the space before '! ? ; : »' -------------------------
// dict/fr.json's curated values set that space with U+0020 (label-final '!' is
// 188 spaced / 9 unspaced, ':' 78 / 4, '?' 48 / 8, '»' 6 / 0; U+00A0 appears
// twice in 991 values). A generated 'Attention!' next to the curated 'Erreur !'
// on the same screen is a visible inconsistency, so layer 3 has to match.

test('French puts a space before the punctuation it re-appends', () => {
  const dict = { 'Kérjük válassz': 'Veuillez sélectionner', 'Adószám': 'Numéro fiscal' };
  const t = createTranslator(dict, { lang: 'fr' });
  assert.equal(t('Kérjük válassz!'), 'Veuillez sélectionner !');
  assert.equal(t('Kérjük válassz?'), 'Veuillez sélectionner ?');
  assert.equal(t('Kérjük válassz;'), 'Veuillez sélectionner ;');
  assert.equal(t('Kérjük válassz»'), 'Veuillez sélectionner »');
  assert.equal(t('Adószám:'), 'Numéro fiscal :');
});

test('the French space is U+0020, the character the curated values use', () => {
  const t = createTranslator({ 'Hiba': 'Erreur' }, { lang: 'fr' });
  assert.equal(t('Hiba!'), 'Erreur !');
  assert.notEqual(t('Hiba!'), 'Erreur\u00A0!'); // NBSP is not the shipped convention
});

test('French leaves the marks that take no space alone', () => {
  const t = createTranslator({
    'Megjegyzés': 'Remarque',
    'Folyamatban': 'En cours',
    'Éves': 'Annuel',
  }, { lang: 'fr' });
  assert.equal(t('Megjegyzés *'), 'Remarque *');   // the app's own spacing
  assert.equal(t('Folyamatban...'), 'En cours...');
  assert.equal(t('Éves,'), 'Annuel,');
});

test('French never doubles a space that is already there', () => {
  // The app itself renders 'Összesen :' on some screens, and a value may end in
  // a space of its own.
  const t = createTranslator({ 'Összesen': 'Total', 'Fizetve': 'Payé ' }, { lang: 'fr' });
  assert.equal(t('Összesen :'), 'Total :');
  assert.equal(t('Fizetve!'), 'Payé !');
});

test('only French gets the space; every other language is untouched', () => {
  const dict = { 'Kérjük válassz': 'Please select' };
  assert.equal(createTranslator(dict, { lang: 'en' })('Kérjük válassz!'), 'Please select!');
  assert.equal(createTranslator(dict, { lang: 'hu' })('Kérjük válassz!'), 'Please select!');
  // An unrecognised, empty or absent lang must behave exactly as it did before
  // the translator took one at all.
  assert.equal(createTranslator(dict, { lang: 'de' })('Kérjük válassz!'), 'Please select!');
  assert.equal(createTranslator(dict, { lang: '' })('Kérjük válassz!'), 'Please select!');
  assert.equal(createTranslator(dict, {})('Kérjük válassz!'), 'Please select!');
  assert.equal(createTranslator(dict)('Kérjük válassz!'), 'Please select!');
});

test('a regional French tag still gets French typography', () => {
  const dict = { 'Hiba': 'Erreur' };
  assert.equal(createTranslator(dict, { lang: 'fr-FR' })('Hiba!'), 'Erreur !');
  assert.equal(createTranslator(dict, { lang: 'FR' })('Hiba!'), 'Erreur !');
  // 'fra' is not the tag this extension ships, so it takes no rule.
  assert.equal(createTranslator(dict, { lang: 'frisian' })('Hiba!'), 'Erreur!');
});

test('an exact French key is emitted verbatim, spacing included', () => {
  // Layer 1 returns a human-authored value: whatever it says goes.
  const t = createTranslator({ 'Hiba!': 'Erreur !', 'Kész!': 'Terminé!' }, { lang: 'fr' });
  assert.equal(t('Hiba!'), 'Erreur !');
  assert.equal(t('Kész!'), 'Terminé!');
});

test('an empty translation is still a miss on the French path', () => {
  const t = createTranslator({ 'Hiba': '' }, { lang: 'fr' });
  assert.equal(t('Hiba!'), null);
});

test('French typography reaches the shouted and the composed layers', () => {
  const t = createTranslator({
    'Figyelem': 'Attention',
    'Cím': 'Adresse',
    'kötelező': 'obligatoire',
  }, { lang: 'fr' });
  assert.equal(t('FIGYELEM!'), 'ATTENTION !');
  assert.equal(t('Cím (kötelező!)'), 'Adresse (obligatoire !)');
});

// --- Layer 5: case variants --------------------------------------------------

test('matches a lowercase rendering of a capitalised key', () => {
  const t = createTranslator({ 'Adószám': 'Tax number' });
  assert.equal(t('adószám'), 'tax number');
});

test('matches a capitalised rendering of a lowercase key', () => {
  const t = createTranslator({ 'adószám': 'tax number' });
  assert.equal(t('Adószám'), 'Tax number');
});

test('matches an ALL-CAPS rendering of a sentence-case key', () => {
  const t = createTranslator({ 'Törlés': 'Delete', 'Figyelem!': 'Attention!' });
  assert.equal(t('TÖRLÉS'), 'DELETE');
  assert.equal(t('FIGYELEM!'), 'ATTENTION!');
});

test('does not lowercase an acronym translation', () => {
  // 'áfa' flips to 'Áfa' → 'VAT'. Recasing the first letter yields 'vAT', and
  // Hungarian prose writes these lowercase mid-sentence, so this really fires.
  const t = createTranslator({ 'Áfa': 'VAT', 'Api kulcs': 'API key' });
  assert.equal(t('áfa'), 'VAT');
  assert.equal(t('api kulcs'), 'API key');
});

test('does not lowercase a label whose capital is followed by a digit', () => {
  // 'i. negyedév' flips to 'I. negyedév' → 'Q1'. The quarter label is 'Q1', never
  // 'q1', and the two-capitals guard does not cover 'Q' + '1'.
  const t = createTranslator({ 'I. negyedév': 'Q1', 'I. n.év': 'Q1' });
  assert.equal(t('i. negyedév'), 'Q1');
  assert.equal(t('i. n.év'), 'Q1');
  assert.equal(createTranslator({ 'I. negyedév': 'T1' })('i. negyedév'), 'T1');
});

test('does not lowercase a proper noun the translation starts with', () => {
  // The app renders this sentence with a lowercase article; lowercasing the
  // translation's first token turns a brand into 'meska.hu'.
  const t = createTranslator({
    'A Meska.hu Magyarország kézműves piactere': "Meska.hu is Hungary's craft marketplace",
    'A PayPal fiókod': 'PayPal account',
    'A Számla.hu oldalon': 'On Számla.hu',
  });
  assert.equal(
    t('a Meska.hu Magyarország kézműves piactere'),
    "Meska.hu is Hungary's craft marketplace",
  );
  assert.equal(t('a PayPal fiókod'), 'PayPal account');
  // Only the leading token is at risk, because only the first character is
  // recased: a brand further along the sentence was never in danger.
  assert.equal(t('a Számla.hu oldalon'), 'on Számla.hu');
});

test('an ordinary capitalised word is still lowercased', () => {
  // The guard has to stay narrow: this is the case the layer exists for, and an
  // abbreviation like 'e.g.' is prose, not a domain.
  const t = createTranslator({
    'Bezárás': 'Close',
    'Például': 'For example',
    'Utca': 'Street, e.g. Fő utca',
  });
  assert.equal(t('bezárás'), 'close');
  assert.equal(t('például'), 'for example');
  assert.equal(t('utca'), 'street, e.g. Fő utca');
});

test('an empty translation is still a miss at the widened case guard', () => {
  const t = createTranslator({ 'I. negyedév': '', 'A PayPal fiókod': '' });
  assert.equal(t('i. negyedév'), null);
  assert.equal(t('a PayPal fiókod'), null);
});

test('shouting a translation spares the tokens whose case means something', () => {
  // Uppercasing the whole value corrupted anything machine-readable inside it.
  const t = createTranslator({
    'Írj nekünk: hello@billingo.hu': 'Write to us: hello@billingo.hu',
    'Kulcs: api_key_abc': 'Key: api_key_abc',
    'Nyisd meg: https://app.billingo.hu/beallitasok':
      'Open: https://app.billingo.hu/beallitasok',
    'Űrlap: szamlazo.hu': 'Form: szamlazo.hu',
  });
  assert.equal(t('ÍRJ NEKÜNK: HELLO@BILLINGO.HU'), 'WRITE TO US: hello@billingo.hu');
  assert.equal(t('KULCS: API_KEY_ABC'), 'KEY: api_key_abc');
  assert.equal(
    t('NYISD MEG: HTTPS://APP.BILLINGO.HU/BEALLITASOK'),
    'OPEN: https://app.billingo.hu/beallitasok',
  );
  assert.equal(t('ŰRLAP: SZAMLAZO.HU'), 'FORM: szamlazo.hu');
});

test('shouting still shouts ordinary prose, punctuation and abbreviations', () => {
  // The spare-list is evidence-based, not a blanket exemption: an abbreviation
  // and a slashed word pair are prose and must shout with the rest.
  const t = createTranslator({
    'Cím (pl.: utca, házszám)': 'Address (e.g.: street, house number)',
    'Átadás iránya/módja': 'Handover direction/method',
  });
  assert.equal(t('CÍM (PL.: UTCA, HÁZSZÁM)'), 'ADDRESS (E.G.: STREET, HOUSE NUMBER)');
  assert.equal(t('ÁTADÁS IRÁNYA/MÓDJA'), 'HANDOVER DIRECTION/METHOD');
});

test('an all-caps input never probes the same case form twice', () => {
  // '5 DB' lowercases to '5 db', whose sentence-case form is identical because
  // '5' has no case — the loop used to try that one form twice. The result is the
  // same either way, so the only observable difference is the wasted probe.
  const probes = [];
  const dict = new Proxy({ '3 db': '3 pcs' }, {
    getOwnPropertyDescriptor(target, key) {
      probes.push(key);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const t = createTranslator(dict);
  t('5 DB');
  assert.equal(probes.filter((key) => key === '5 db').length, 1);
});

test('an exact key beats its case-flipped sibling', () => {
  const t = createTranslator({ 'Rét': 'Tue', 'rét': 'meadow' });
  assert.equal(t('rét'), 'meadow');
  assert.equal(t('Rét'), 'Tue');
});

test('the punctuation layer runs before the case layer', () => {
  const t = createTranslator({ 'Bezárás': 'Close' });
  assert.equal(t('bezárás:'), 'close:');
});

test('an uncased first character has no case variant to try', () => {
  const t = createTranslator({ '3 db': '3 pcs' });
  assert.equal(t('12 345 Ft'), null);
  assert.equal(t('—'), null);
});

test('the case layer never returns its own input', () => {
  // 'Standard' translates to itself; echoing the input would count as a hit in
  // the walker and inflate the coverage percentage.
  const t = createTranslator({ 'Standard': 'Standard' });
  assert.equal(t('STANDARD'), null);
});

test('an empty translation is still a miss at the case layer', () => {
  const t = createTranslator({ 'Adószám': '', 'Törlés': '' });
  assert.equal(t('adószám'), null);
  assert.equal(t('TÖRLÉS'), null);
});

test('the case layer reads the dictionary live', () => {
  const dict = { 'Számlák': 'Invoices' };
  const t = createTranslator(dict);
  assert.equal(t('adószám'), null);
  Object.assign(dict, { 'Adószám': 'Tax number' });
  assert.equal(t('adószám'), 'tax number');
});

// --- Layer 7: parenthetical tail ---------------------------------------------

test('composes a known head with a known parenthetical tail', () => {
  const t = createTranslator({ 'Cím': 'Adresse', 'opcionális': 'facultatif' });
  assert.equal(t('Cím (opcionális)'), 'Adresse (facultatif)');
});

test('an unresolved lettered tail blocks the layer', () => {
  // All or nothing, like layer 8. This layer decomposes arbitrary strings and the
  // walker cannot tell UI chrome from user data, so an unknown word in the tail
  // used to be enough to get the head rewritten: a product literally named
  // 'Termék (Nagy)' became 'Product (Nagy)' — a surname kept, a noun translated —
  // on an invoice line whose issued PDF still says 'Termék'.
  const t = createTranslator({
    'Cím': 'Adresse',
    'Termék': 'Product',
    'Javítás': 'Correction',
  });
  assert.equal(t('Cím (pl. utca, házszám)'), null);
  assert.equal(t('Termék (Nagy)'), null);
  assert.equal(t('Javítás (XJZ-2020-109)'), null);
});

test('a tail with no letter passes through untouched', () => {
  // 'Mind (0)', '(2026-01-01)', '(1 234 Ft)' carry no lexeme, so they neither
  // need to resolve nor block the layer.
  const t = createTranslator({ 'Mind': 'All', 'Bevétel': 'Revenue' });
  assert.equal(t('Mind (0)'), 'All (0)');
  assert.equal(t('Bevétel (2026-01-01)'), 'Revenue (2026-01-01)');
  assert.equal(t('Bevétel (12,5 %)'), 'Revenue (12,5 %)');
});

test('resolves a parenthetical tail through the lower layers', () => {
  // The tail goes through layers 1-3 + 5, so a case variant still matches.
  const t = createTranslator({ 'Bevétel': 'Revenu', 'Opcionális': 'Facultatif' });
  assert.equal(t('Bevétel (opcionális)'), 'Revenu (facultatif)');
});

test('never emits a bare parenthetical when the head misses', () => {
  const t = createTranslator({ 'opcionális': 'facultatif' });
  assert.equal(t('Bármi (opcionális)'), null);
});

test('a glued Head(tail) is Hungarian morphology, not a parenthetical', () => {
  // 'E-mail cím(ek)' must not become 'E-mail address (ek)' — the layer requires
  // whitespace before '(' precisely because every glued form is an inflection.
  const t = createTranslator({ 'E-mail cím': 'E-mail address', 'hónap': 'month' });
  assert.equal(t('E-mail cím(ek)'), null);
  assert.equal(t('hónap(ok)'), null);
});

test('nested parentheses are refused', () => {
  const t = createTranslator({ 'Cím': 'Adresse' });
  assert.equal(t('Cím (a (belső) rész)'), null);
});

test('a long prose string is not decomposed as a parenthetical', () => {
  const t = createTranslator({
    'Ez egy nagyon hosszú magyar mondat amely véletlenül tartalmaz zárójelet is': 'x',
  });
  assert.equal(
    t('Ez egy nagyon hosszú magyar mondat amely véletlenül tartalmaz zárójelet is (igen)'),
    null,
  );
});

test('the parenthetical layer never returns its own input', () => {
  const t = createTranslator({ 'ÁTHK': 'ÁTHK', 'ÁFA': 'ÁFA' });
  assert.equal(t('ÁTHK (ÁFA)'), null);
});

test('an empty translation is still a miss at the parenthetical layer', () => {
  assert.equal(createTranslator({ 'Cím': '', 'opcionális': 'facultatif' })('Cím (opcionális)'), null);
  // An empty tail value is a miss too, and a miss now blocks the layer — it must
  // never leave a blank inside the parentheses.
  assert.equal(createTranslator({ 'Cím': 'Adresse', 'opcionális': '' })('Cím (opcionális)'), null);
});

test('a pattern with a :token inside parentheses beats decomposition', () => {
  // Layer 4 must run first: it knows the whole sentence, so the tail comes out as
  // '(Ligne: 3)' instead of the half-translated '(Sor: 3)' layer 7 would emit.
  const t = createTranslator({
    'Hibás tétel (Sor: :line)': 'Ligne incorrecte (Ligne: :line)',
    'Hibás tétel': 'Ligne incorrecte',
  });
  assert.equal(t('Hibás tétel (Sor: 3)'), 'Ligne incorrecte (Ligne: 3)');
});

// --- Layer 8: separator split ------------------------------------------------

test('composes a table header the capture never saw as a pair', () => {
  const t = createTranslator({ 'Kelt': 'Date', 'Fizetve': 'Payé' });
  assert.equal(t('Kelt / Fizetve'), 'Date / Payé');
});

test('splits on a spaced dash and on a pipe', () => {
  const t = createTranslator({
    'Beállítások': 'Paramètres',
    'Adatok': 'Données',
    'Bevétel': 'Revenu',
  });
  assert.equal(t('Beállítások - Adatok'), 'Paramètres - Données');
  assert.equal(t('Beállítások | Bevétel'), 'Paramètres | Revenu');
});

test('an exact key wins over splitting it', () => {
  const t = createTranslator({
    'Kelt / Teljesítés': 'Date / Livraison',
    'Kelt': 'Date',
    'Teljesítés': 'Performance',
  });
  assert.equal(t('Kelt / Teljesítés'), 'Date / Livraison');
});

test('splitting is all or nothing', () => {
  // A half-resolved split emits mixed-language output, which reads as a broken
  // extension rather than a partial translation.
  const t = createTranslator({ 'Kelt': 'Date' });
  assert.equal(t('Kelt / Fizetve'), null);
});

test('a bare separator is never split', () => {
  // 273 keys carry a bare '/' — 'Swift/BIC kód', 'Ft/hó', every URL.
  const t = createTranslator({ 'Swift': 'Swift', 'BIC kód': 'code BIC', 'hó': 'mois' });
  assert.equal(t('Swift/BIC kód'), null);
  assert.equal(t('Ft/hó'), null);
});

test('a date range is not a separator list', () => {
  const t = createTranslator({ 'Kelt': 'Date' });
  assert.equal(t('2026-01-01 - 2026-02-01'), null);
});

test('a numeric range is not a separator list', () => {
  const t = createTranslator({ 'Kelt': 'Date' });
  assert.equal(t('1 - 3'), null);
  assert.equal(t('1 / 2'), null);
});

test('a string made only of separators is a miss', () => {
  const t = createTranslator({ 'Kelt': 'Date' });
  assert.equal(t('- - -'), null);
  assert.equal(t('/ /'), null);
  assert.equal(t(' | '), null);
});

test('a non-lettered part is kept verbatim without voting on the outcome', () => {
  const t = createTranslator({ 'Összesen': 'Total' });
  assert.equal(t('Összesen / 12'), 'Total / 12');
});

test('a single-character unknown part blocks the split', () => {
  const t = createTranslator({ 'Számlák': 'Factures' });
  assert.equal(t('A / Számlák'), null);
});

test('more than four segments is prose, not a composed label', () => {
  const t = createTranslator({ 'A': 'A', 'B': 'B', 'C': 'C', 'D': 'D', 'E': 'E' });
  assert.equal(t('A / B / C / D / E'), null);
});

test('many separators resolve through a non-splitting path (no recursion)', () => {
  // The composite layers resolve their fragments with layers 1-3 + 5 only, so a
  // separator-dense string can never re-enter the splitting layer.
  const dict = { 'Kelt': 'Date' };
  const t = createTranslator(dict);
  const long = Array.from({ length: 40 }, () => 'Kelt').join(' / ');
  assert.equal(t(long), null);
  assert.equal(t(`Kelt (${long})`), null);
  assert.equal(t(`${long} (Kelt / Kelt)`), null);
});

test('a long dash-containing sentence is not split', () => {
  const t = createTranslator({ 'Számlák': 'Factures', 'a rendszer': 'le système' });
  assert.equal(
    t('Számlák - a rendszer minden bizonylatot automatikusan eltárol és listáz neked'),
    null,
  );
});

test('the separator layer never returns its own input', () => {
  const t = createTranslator({ 'Standard': 'Standard', 'Basic': 'Basic' });
  assert.equal(t('Standard / Basic'), null);
});

test('an empty translation is still a miss at the separator layer', () => {
  const t = createTranslator({ 'Kelt': 'Date', 'Fizetve': '' });
  assert.equal(t('Kelt / Fizetve'), null);
});

test('the composite layers read the dictionary live', () => {
  const dict = { 'Fizetve': 'Payé' };
  const t = createTranslator(dict);
  assert.equal(t('Kelt / Fizetve'), null);
  assert.equal(t('Kelt (opcionális)'), null);   // head unknown, so no output at all
  Object.assign(dict, { 'Kelt': 'Date', 'opcionális': 'facultatif' });
  assert.equal(t('Kelt / Fizetve'), 'Date / Payé');
  assert.equal(t('Kelt (opcionális)'), 'Date (facultatif)');
});

// --- Layer 4a: named (:token) patterns --------------------------------------

test('fills a :token pattern with the rendered value', () => {
  const t = createTranslator({ ':type előtag': 'Préfixe :type' });
  assert.equal(t('Számla előtag'), 'Préfixe Számla');
});

test('translates the captured fragment when the dictionary knows it', () => {
  const t = createTranslator({
    ':type letöltése': 'Télécharger :type',
    'Számla': 'Facture',
  });
  assert.equal(t('Számla letöltése'), 'Télécharger Facture');
});

test('fills several distinct tokens', () => {
  const t = createTranslator({
    ':day nap és :hour óra': ':day jours et :hour heures',
  });
  assert.equal(t('5 nap és 3 óra'), '5 jours et 3 heures');
});

test('reorders tokens according to the translation', () => {
  const t = createTranslator({ ':a után :b': ':b avant :a' });
  assert.equal(t('alma után körte'), 'körte avant alma');
});

test('a pattern with no literal text never matches (no catch-all)', () => {
  const t = createTranslator({ ':type': 'Type :type', 'Számlák': 'Factures' });
  assert.equal(t('bármi'), null);
  assert.equal(t('Számlák'), 'Factures');
});

test('a pattern whose translation drops a token is not usable', () => {
  // Cannot rebuild the sentence: the FR side lost :number.
  const t = createTranslator({ 'Cégjegyzékszám: :number kiadva': 'Non traduit' });
  assert.equal(t('Cégjegyzékszám: 01-09-123456 kiadva'), null);
});

// --- Layer 4b: numeric patterns ---------------------------------------------

test('generalises a numeric key to any number', () => {
  const t = createTranslator({ '3 db': '3 pcs' });
  assert.equal(t('7 db'), '7 pcs');
});

test('generalises a percentage key', () => {
  const t = createTranslator({ '27% ÁFA': '27% TVA' });
  assert.equal(t('5% ÁFA'), '5% TVA');
});

test('prefers a plural source pair when several share the same shape', () => {
  const t = createTranslator({ '1 nap': '1 jour', '5 nap': '5 jours' });
  assert.equal(t('12 nap'), '12 jours');
});

test('does not build a pattern from a pure date-shaped key', () => {
  // '2026-01-01' has no lettered literal — generalising it would match every date
  // and translate it to itself.
  const t = createTranslator({ '2026-01-01': '2026-01-01' });
  assert.equal(t('2024-07-31'), null);
});

test('numbers in a key with no lettered literal do not generalise', () => {
  const t = createTranslator({ '1 / 2': '1 / 2' });
  assert.equal(t('3 / 4'), null);
});

// --- Ordering and safety -----------------------------------------------------

test('the most specific pattern wins', () => {
  const t = createTranslator({
    ':type letöltése': 'Télécharger :type',
    'Számla :type letöltése': 'Télécharger la facture :type',
  });
  assert.equal(t('Számla PDF letöltése'), 'Télécharger la facture PDF');
});

test('an empty translation is still a miss at every layer', () => {
  const t = createTranslator({ ':type előtag': '', 'Adószám': '' });
  assert.equal(t('Számla előtag'), null);
  assert.equal(t('Adószám:'), null);
});

test('inherited Object properties are never treated as translations', () => {
  const t = createTranslator({ 'Számlák': 'Factures' });
  assert.equal(t('constructor'), null);
  assert.equal(t('toString'), null);
  assert.equal(t('__proto__'), null);
});

test('the exact and punctuation layers read the dictionary live', () => {
  // The shard loader merges new zones into the same object the translator holds.
  const dict = { 'Számlák': 'Factures' };
  const t = createTranslator(dict);
  assert.equal(t('Adószám:'), null);
  Object.assign(dict, { 'Adószám': 'Numéro fiscal' });
  assert.equal(t('Adószám:'), 'Numéro fiscal:');
});

test('refresh() rebuilds the pattern index after new shards are merged', () => {
  const dict = { 'Számlák': 'Factures' };
  const t = createTranslator(dict);
  assert.equal(t('Számla letöltése'), null);   // builds the (empty) pattern index
  Object.assign(dict, { ':type letöltése': 'Télécharger :type' });
  assert.equal(t('Számla letöltése'), null);   // index still stale
  t.refresh();
  assert.equal(t('Számla letöltése'), 'Télécharger Számla');
});

// --- Unicode normalisation ---------------------------------------------------
// Exactly 2 of the app's ~10 400 strings ('Bejegyzés kelte', 'Bejegyzés dátuma')
// render with combining accents, and 0 dictionary keys do, so byte equality can
// never match them. NFC is folded into the whitespace-normalising helper, which
// only runs once the exact layer has already missed.

const NFD = (s) => s.normalize('NFD');

test('a decomposed rendering matches a composed key', () => {
  const t = createTranslator({ 'Bejegyzés kelte': 'Date of registration' });
  const probe = NFD('Bejegyzés kelte');
  assert.notEqual(probe, 'Bejegyzés kelte');           // really is non-NFC
  assert.equal(probe.normalize('NFC'), 'Bejegyzés kelte');
  assert.equal(t(probe), 'Date of registration');
});

test('normalisation composes with the layers above it', () => {
  const t = createTranslator({ 'Bejegyzés kelte': 'Date of registration' }, { lang: 'fr' });
  assert.equal(t(NFD('Bejegyzés kelte:')), 'Date of registration :'); // layer 3
  assert.equal(t(NFD('  Bejegyzés\n   kelte ')), 'Date of registration'); // layer 2
  assert.equal(t(NFD('bejegyzés kelte')), 'date of registration'); // layer 5
});

test('normalisation does not invent a match', () => {
  const t = createTranslator({ 'Bejegyzés kelte': 'Date of registration' });
  assert.equal(t(NFD('Bejegyzés dátuma')), null);
});

test('an empty translation is still a miss on the normalising path', () => {
  const t = createTranslator({ 'Bejegyzés kelte': '' });
  assert.equal(t(NFD('Bejegyzés kelte')), null);
});

test('refresh() invalidates the normalised index too', () => {
  // The normalised index is the derived structure the NFC path reads, so a zone
  // merged after it was built is invisible until refresh() drops it.
  const dict = { 'Számlák': 'Factures' };
  const t = createTranslator(dict);
  const probe = NFD('Bejegyzés kelte');
  assert.equal(t(probe), null);                 // builds the index
  Object.assign(dict, { 'Bejegyzés kelte': "Date d'inscription" });
  assert.equal(t(probe), null);                 // index still stale
  t.refresh();
  assert.equal(t(probe), "Date d'inscription");
});
