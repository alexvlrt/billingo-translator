#!/usr/bin/env node
// Resize Billingo's source PNG into the three sizes our manifest needs
// (16, 48, 128). Uses Playwright's headless Chromium as the resizer since
// we don't have Pillow/sharp/imagemagick available.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = '/tmp/billingo-icons/144x144.png';
const TARGETS = [
  { size: 16, out: 'icons/icon16.png' },
  { size: 48, out: 'icons/icon48.png' },
  { size: 128, out: 'icons/icon128.png' },
];

const cachedChromium =
  '/home/alex/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(cachedChromium) ? cachedChromium : undefined,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ deviceScaleFactor: 1 });

  const sourceBytes = fs.readFileSync(SOURCE);
  const sourceB64 = sourceBytes.toString('base64');

  for (const { size, out } of TARGETS) {
    const html = `<!DOCTYPE html><html><head><style>
      html,body{margin:0;padding:0;background:transparent;}
      canvas{display:block;width:${size}px;height:${size}px;}
    </style></head><body>
    <canvas id="c" width="${size}" height="${size}"></canvas>
    <script>
      const img = new Image();
      img.onload = () => {
        const c = document.getElementById('c');
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, ${size}, ${size});
        document.body.dataset.ready = '1';
      };
      img.src = 'data:image/png;base64,${sourceB64}';
    </script>
    </body></html>`;
    const page = await context.newPage();
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(html);
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    const dataUrl = await page.evaluate(() => {
      return document.getElementById('c').toDataURL('image/png');
    });
    const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    fs.writeFileSync(out, png);
    console.log(`${out}: ${size}x${size}, ${png.length} bytes`);
    await page.close();
  }

  await browser.close();
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
