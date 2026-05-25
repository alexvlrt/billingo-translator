#!/usr/bin/env node
// Render the wizard with the extension loaded, take a screenshot, dump the
// outerHTML, and dump all visible HU-shaped strings *after the extension
// translates*. Used to understand why the user still sees Hungarian.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const cookieFile = process.argv[2] || '/tmp/billingo-crawl/jar.txt';
const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function loadCookies(p) {
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, , pp, secure, , name, value] = parts;
    out.push({
      name, value,
      url: `https://${domain.replace(/^\./, '')}${pp}`,
      httpOnly: name.toLowerCase() === 'laravel_session',
      secure: secure.toLowerCase() === 'true',
      sameSite: 'Lax',
    });
  }
  return out;
}

const cachedChromium = '/home/alex/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const profileDir = '/tmp/bt-inspect-profile';
fs.rmSync(profileDir, { recursive: true, force: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  executablePath: fs.existsSync(cachedChromium) ? cachedChromium : undefined,
  args: [
    `--disable-extensions-except=${PROJECT_DIR}`,
    `--load-extension=${PROJECT_DIR}`,
    '--no-sandbox',
  ],
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0',
  viewport: { width: 1280, height: 1600 },
});
await context.addInitScript(() => {
  if (document.documentElement) document.documentElement.setAttribute('data-bt-lang', 'fr');
  new MutationObserver((_, o) => {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-bt-lang', 'fr');
      o.disconnect();
    }
  }).observe(document, { childList: true, subtree: true });
});
await context.addCookies(loadCookies(cookieFile));

const page = await context.newPage();

console.error('Loading wizard…');
await page.goto('https://app.billingo.hu/n/bob/connection-wizard/1', {
  waitUntil: 'networkidle', timeout: 30000,
}).catch(() => {});
await page.waitForTimeout(4000);

// Snapshot 1: initial wizard
await page.screenshot({ path: '/tmp/wizard-step1.png', fullPage: true });
console.error('Saved /tmp/wizard-step1.png');

// Try to interact with the country card. Look for clickable country cards.
const cardCount = await page.evaluate(() => {
  const els = [...document.querySelectorAll('button, a, [role="button"], [class*="card"], [class*="Card"], [tabindex]')];
  const interesting = els.filter((e) => {
    const t = (e.textContent || '').trim();
    return t === 'Magyarország' || t === 'Hungary' || t === 'Hongrie';
  });
  return { totalClickable: els.length, hungaryMatches: interesting.length };
});
console.error('Clickable elements:', JSON.stringify(cardCount));

const click = await page.evaluate(() => {
  const els = [...document.querySelectorAll('*')];
  for (const e of els) {
    const t = (e.textContent || '').trim();
    if ((t === 'Magyarország' || t === 'Hongrie' || t === 'Hungary') && e.children.length === 0) {
      // Click the closest clickable ancestor.
      let p = e;
      while (p && p !== document.body) {
        const tag = p.tagName;
        if (tag === 'BUTTON' || tag === 'A' || p.getAttribute('role') === 'button' || p.tabIndex >= 0) {
          p.click();
          return { ok: true, tag, classes: p.className };
        }
        p = p.parentElement;
      }
      // Fallback: click the leaf
      e.click();
      return { ok: true, tag: e.tagName, classes: e.className, fallback: true };
    }
  }
  return { ok: false };
});
console.error('Country click:', JSON.stringify(click));
await page.waitForTimeout(3000);

await page.screenshot({ path: '/tmp/wizard-after-country.png', fullPage: true });
console.error('Saved /tmp/wizard-after-country.png');

// Snapshot strings post-country-click.
const strings = await page.evaluate(() => {
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
  let n; while ((n = tw.nextNode())) out.add(n.nodeValue.trim());
  return [...out];
});

const HU = /[őűáéíóöúüŐŰÁÉÍÓÖÚÜ]/;
const dict = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'dict/fr.json'), 'utf8'));
const stillHu = strings.filter((s) => HU.test(s) && !(dict[s]));
console.error(`After country click: ${strings.length} strings, ${stillHu.length} HU-shaped not in dict.fr`);
fs.writeFileSync('/tmp/wizard-still-hu.txt', stillHu.join('\n'));
console.error(`Sample still-HU (first 20):`);
stillHu.slice(0, 20).forEach((s) => console.error(' ', JSON.stringify(s.slice(0, 120))));

await context.close();
