import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutes, mapStringsToZones } from '../tools/bundle/route-map.js';
import { zoneForRoute, buildIndex } from '../tools/zones.js';

test('parseRoutes pairs each path with the chunk ids it lazy-loads', () => {
  const src = 'path:"/document/list",component:()=>r.e(10).then(r.bind(r,1)),'
    + 'path:"/api/list",component:()=>Promise.all([r.e(20),r.e(21)]).then(()=>{})';
  const routes = parseRoutes(src);
  assert.deepEqual(routes.find((x) => x.path === '/document/list').chunkIds, [10]);
  assert.deepEqual(routes.find((x) => x.path === '/api/list').chunkIds, [20, 21]);
});

test('mapStringsToZones resolves known prefixes and falls back to _common', () => {
  const idx = buildIndex();
  const extracted = { 'Számla': ['hA'], 'Új kulcs': ['hB'], 'Általános': ['hVendor'] };
  const manifest = { 10: 'hA', 20: 'hB', 99: 'hVendor' };
  const routes = [
    { path: '/document/list', chunkIds: [10] },        // -> /n/document -> documents (known)
    { path: '/widgetlab/list', chunkIds: [20] },       // -> /n/widgetlab -> NEW zone (not in zones.js)
  ];
  const { observed, newZones } = mapStringsToZones({
    extracted, manifest, routes, zoneForRoute: (p) => zoneForRoute(p, idx),
  });
  assert.deepEqual(observed['Számla'], ['documents']);
  assert.deepEqual(observed['Új kulcs'], ['widgetlab']);
  assert.deepEqual(observed['Általános'], ['_common']); // hVendor in no route -> _common
  assert.deepEqual(newZones, [{ prefix: '/n/widgetlab', zone: 'widgetlab' }]);
});
