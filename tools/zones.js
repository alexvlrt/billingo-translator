// tools/zones.js
// Source unique de vérité : zone applicative → préfixes d'URL Billingo.
// Pur (ESM). Importé par build-shards.js et diagnose-extension.js.
// _index.json (consommé par le loader runtime de P2) en dérive via buildIndex().

export const ZONES = {
  dashboard:    ['/n/dashboard'],
  documents:    ['/n/document', '/n/external-invoice-import'],
  partners:     ['/n/partner'],
  products:     ['/n/product'],
  spending:     ['/n/spending'],
  bank:         ['/n/bank-account', '/n/bob'],
  ceginfo:      ['/n/ceginfo'],
  inventory:    ['/n/inventory', '/n/organization-place'],
  settings:     ['/n/organization-setting', '/n/nav-online-szamla'],
  users:        ['/n/user', '/n/user-invitation'],
  subscription: ['/n/subscription', '/n/affiliate', '/n/accountant-affiliate'],
  marketplace:  ['/n/marketplace'],
  marketing:    ['/n/campaign-manager', '/n/tender-monitor'],
  tax:          ['/n/flat-tax', '/n/kata'],
  // Added 2026-05-25 from the bundle route table (tools/bundle/new-zones.json).
  api:          ['/n/api'],
  billingopay:  ['/n/billingo-pay'],
  organizationwizard: ['/n/organization-wizard'],
  phonevalidate: ['/n/phone-validate'],
  organization: ['/n/organization'],
  kyc:          ['/n/kyc'],
  ubo:          ['/n/ubo'],
  // Ajouté 2026-08-03 après relecture complète de la table de routes du bundle
  // (230 routes) : deux surfaces UTILISATEUR qui tombaient sur zoneForRoute() → null.
  //   claim-management (Követeléskezelés) : /claim-management/documents et
  //     /claim-management/wizard. Atteignable depuis les factures échues — le bundle
  //     la câble dans le menu principal (mainMenuDefaultFilterParameters
  //     ["claim-management"]) et pousse nuxt.claim-management.wizard depuis la liste
  //     des documents EXPIRED. Aucune collision : les autres préfixes en /n/c… sont
  //     /n/campaign-manager et /n/ceginfo, dont aucun n'est préfixe de l'autre.
  //   auth : les routes /auth du Nuxt (registration, registration/activate,
  //     activation-resend, password-reset, otp, im-not-a-robot, email) sont de vrais
  //     parcours client. Le login public, lui, n'est PAS ici : aucune route
  //     /auth/login dans la table — il est servi par l'ancien front v3 et reste
  //     couvert par _common. Voir la note EXCLUDE de tools/extract-bundle.js.
  // Les noms de zone reprennent la dérivation de route-map.js (premier segment,
  // minuscules, non-alphanumériques retirés) pour que le mapping bundle→zone donne
  // exactement ce nom au lieu de proposer une « new zone ».
  claimmanagement: ['/n/claim-management'],
  auth:         ['/n/auth'],
};

export function buildIndex() {
  const entries = [];
  for (const [zone, prefixes] of Object.entries(ZONES)) {
    for (const prefix of prefixes) entries.push({ prefix, shard: zone });
  }
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
  return entries;
}

export function zoneForRoute(pathname, index = buildIndex()) {
  for (const { prefix, shard } of index) {
    if (pathname.startsWith(prefix)) return shard;
  }
  return null;
}
