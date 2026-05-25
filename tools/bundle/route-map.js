// tools/bundle/route-map.js — pure mapping of bundle strings to translation zones.

// Nuxt route entries look like {path:"/api/list",component:()=>...r.e(123)...}.
// We capture, per `path:"..."`, every webpack chunk id (`.e(<n>)`) referenced
// before the next `path:"..."` (its lazy component + nested chunks).
export function parseRoutes(source) {
  const marks = [...source.matchAll(/path:"((?:\\.|[^"\\])*)"/g)]
    .map((m) => ({ path: m[1], index: m.index }));
  const routes = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : start + 4000;
    const slice = source.slice(start, end);
    const ids = [...slice.matchAll(/\.e\((\d{1,5})\)/g)].map((m) => Number(m[1]));
    routes.push({ path: marks[i].path, chunkIds: [...new Set(ids)] });
  }
  return routes;
}

// extracted: { hu: hash[] }  manifest: { id:hash }  routes: [{path,chunkIds}]
// zoneForRoute(pathname)->zone|null (zones.js, /n-prefixed). base prepended to paths.
// Returns { observed:{hu:zone[]}, newZones:[{prefix,zone}] }.
export function mapStringsToZones({ extracted, manifest, routes, zoneForRoute, base = '/n' }) {
  const hashToZones = new Map();
  const newZones = new Map();
  const add = (hash, zone) => {
    if (!hashToZones.has(hash)) hashToZones.set(hash, new Set());
    hashToZones.get(hash).add(zone);
  };
  for (const { path, chunkIds } of routes) {
    let zone = zoneForRoute(base + path);
    if (!zone) {
      const seg = (path.split('/').filter(Boolean)[0] || 'misc').toLowerCase().replace(/[^a-z0-9]/g, '');
      zone = seg || 'misc';
      const prefix = base + '/' + (path.split('/').filter(Boolean)[0] || 'misc');
      if (!newZones.has(prefix)) newZones.set(prefix, zone);
    }
    for (const id of chunkIds) {
      const hash = manifest[id];
      if (hash) add(hash, zone);
    }
  }
  const observed = {};
  for (const [hu, hashes] of Object.entries(extracted)) {
    const zones = new Set();
    for (const h of hashes) for (const z of hashToZones.get(h) || []) zones.add(z);
    observed[hu] = zones.size ? [...zones] : ['_common'];
  }
  return { observed, newZones: [...newZones].map(([prefix, zone]) => ({ prefix, zone })) };
}
