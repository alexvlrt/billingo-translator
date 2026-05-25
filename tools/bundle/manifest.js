// tools/bundle/manifest.js — pure parsers for the Nuxt/webpack bundle.

// The runtime chunk contains a map  {0:"hash",1:"hash",...}[e]+".js"
// (filenames are pure hashes; no separate name map observed). Returns {id:hash}.
// We locate the map region by the trailing `}[e]+".js"` concat, then pull every
// id:"hash" pair from it — a few entries use a non-string value (webpack edge
// chunks) and are simply skipped rather than aborting the whole parse.
export function parseChunkManifest(source) {
  const tail = source.match(/\}\[\w+\]\+"\.js"/);
  if (!tail) return {};
  const open = source.lastIndexOf('{', tail.index);
  if (open === -1) return {};
  const region = source.slice(open, tail.index);
  const map = {};
  for (const p of region.matchAll(/(\d+):"([a-f0-9]{6,9})"/g)) map[Number(p[1])] = p[2];
  return map;
}

// All <script src="....js"> absolute URLs from the authenticated shell HTML.
export function scriptSrcUrls(html) {
  return [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]);
}
