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
