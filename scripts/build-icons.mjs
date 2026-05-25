// Regenerate the toolbar PNG icons from icons/icon.svg.
//
// `sharp` is intentionally NOT a project dependency (it pulls a large native
// binary and is only needed when the logo changes). Install it ad hoc:
//
//   npm i sharp
//   node scripts/build-icons.mjs
//
// The SVG glyph is already traced to a path, so no fonts are required.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const svg = readFileSync(join(root, 'icons', 'icon.svg'));

const sizes = [16, 48, 128];

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('sharp is not installed. Run:  npm i sharp');
  process.exit(1);
}

for (const size of sizes) {
  const out = join(root, 'icons', `icon${size}.png`);
  await sharp(svg, { density: 512 }).resize(size, size).png().toFile(out);
  console.log(`wrote icons/icon${size}.png`);
}
