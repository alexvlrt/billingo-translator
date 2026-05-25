#!/usr/bin/env node
// Render the bank-sync wizard via playwright with auth cookies and extract
// all visible HU strings post-hydration. Read-only — no clicks, no submits.

import { chromium } from 'playwright';
import fs from 'node:fs';

const cookieFile = process.argv[2] || '/tmp/billingo-crawl/jar.txt';
const cookies = [];
for (const line of fs.readFileSync(cookieFile, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const parts = line.split('\t');
  if (parts.length < 7) continue;
  const [domain, , p, secure, , name, value] = parts;
  cookies.push({
    name, value,
    url: `https://${domain.replace(/^\./, '')}${p}`,
    httpOnly: name.toLowerCase() === 'laravel_session',
    secure: secure.toLowerCase() === 'true',
    sameSite: 'Lax',
  });
}

const URLS = [
  'https://app.billingo.hu/n/bob/connection-wizard',
  'https://app.billingo.hu/n/bob/connection-wizard/1',
  'https://app.billingo.hu/n/bob/connection-wizard/2',
  'https://app.billingo.hu/n/bob/connection-wizard/3',
  'https://app.billingo.hu/n/bob/connection-wizard/4',
];

const cachedChromium = '/home/alex/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const browser = await chromium.launch({
  headless: true,
  executablePath: fs.existsSync(cachedChromium) ? cachedChromium : undefined,
  args: ['--no-sandbox'],
});
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0',
  viewport: { width: 1280, height: 900 },
});
await context.addCookies(cookies);

const all = new Set();
const page = await context.newPage();

for (const url of URLS) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3500);
    // Try scrolling to reveal lazy content.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    const found = await page.evaluate(() => {
      const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEXTAREA']);
      const out = new Set();
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = n.parentNode;
          if (!p || SKIP.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
          const v = n.nodeValue && n.nodeValue.trim();
          if (!v) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let n;
      while ((n = tw.nextNode())) out.add(n.nodeValue.trim());
      const ew = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let el = ew.nextNode();
      while (el) {
        if (!SKIP.has(el.nodeName)) {
          for (const a of ['placeholder','title','aria-label','alt']) {
            const v = el.getAttribute && el.getAttribute(a);
            if (v && v.trim()) out.add(v.trim());
          }
        }
        el = ew.nextNode();
      }
      return [...out];
    });
    for (const s of found) all.add(s);
    console.error(`${url} → +${found.length} (total: ${all.size})`);
  } catch (err) {
    console.error(`${url} ERROR: ${err.message}`);
  }
}

await browser.close();

for (const s of [...all].sort((a, b) => a.localeCompare(b, 'hu'))) {
  console.log(s);
}
