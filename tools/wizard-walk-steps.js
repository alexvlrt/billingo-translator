#!/usr/bin/env node
// Walk the bank-sync wizard step by step using the visible "Suivant"/"Next"
// button. READ-ONLY: stops short of any redirect-to-bank action. Saves a
// screenshot of every step + dumps every HU-shaped string for translation.

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
const profileDir = '/tmp/bt-walksteps-profile';
fs.rmSync(profileDir, { recursive: true, force: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  executablePath: fs.existsSync(cachedChromium) ? cachedChromium : undefined,
  args: [
    `--disable-extensions-except=${PROJECT_DIR}`,
    `--load-extension=${PROJECT_DIR}`,
    '--no-sandbox',
  ],
  viewport: { width: 1280, height: 1100 },
});
// Force HU lang so we can see what would otherwise be untranslated.
await context.addInitScript(() => {
  if (document.documentElement) document.documentElement.setAttribute('data-bt-lang', 'hu');
  new MutationObserver((_, o) => {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-bt-lang', 'hu');
      o.disconnect();
    }
  }).observe(document, { childList: true, subtree: true });
});
await context.addCookies(loadCookies(cookieFile));

const all = new Set();
const page = await context.newPage();

await page.goto('https://app.billingo.hu/n/bob/connection-wizard/1', {
  waitUntil: 'networkidle', timeout: 30000,
}).catch(() => {});
await page.waitForTimeout(4000);

async function snap(stepName) {
  await page.screenshot({ path: `/tmp/wizard-${stepName}.png`, fullPage: true });
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
    let n; while ((n = tw.nextNode())) out.add(n.nodeValue.trim());
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
  console.error(`[${stepName}] +${found.length} (total: ${all.size})`);
}

await snap('step1');

// Click "Tovább" (Suivant button is "Tovább" in Hungarian).
async function clickSuivant() {
  const ok = await page.evaluate(() => {
    // Try several text/aria combinations that might be the "next/forward" button.
    const candidates = ['Következő', 'Tovább', 'Suivant', 'Next', 'Folytatás', 'Folytatom'];
    for (const txt of candidates) {
      const el = [...document.querySelectorAll('button, [role="button"]')].find(
        (b) => (b.textContent || '').trim() === txt
      );
      if (el) {
        el.click();
        return { ok: true, label: txt };
      }
    }
    return { ok: false };
  });
  console.error('Click Suivant:', JSON.stringify(ok));
  return ok.ok;
}

// Walk forward up to 5 steps.
for (let i = 2; i <= 6; i++) {
  if (!(await clickSuivant())) break;
  await page.waitForTimeout(3500);
  await snap(`step${i}`);
  // If a list of banks appeared, click the first one (e.g., 'OTP').
  const bankClicked = await page.evaluate(() => {
    const banks = ['OTP', 'K&H', 'Erste', 'Raiffeisen', 'MBH', 'Unicredit', 'Magnet', 'CIB', 'Takarékbank', 'Revolut', 'Wise'];
    for (const b of banks) {
      const el = [...document.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === b
      );
      if (el) {
        let p = el;
        while (p && p !== document.body) {
          if (p.tagName === 'BUTTON' || p.tagName === 'A' || p.getAttribute('role') === 'button' || p.tabIndex >= 0) {
            p.click();
            return { bank: b, tag: p.tagName };
          }
          p = p.parentElement;
        }
        el.click();
        return { bank: b, tag: el.tagName, fallback: true };
      }
    }
    return null;
  });
  if (bankClicked) {
    console.error('Bank click:', JSON.stringify(bankClicked));
    await page.waitForTimeout(3000);
    await snap(`step${i}-bank`);
  }
}

await context.close();

const sorted = [...all].sort((a, b) => a.localeCompare(b, 'hu'));
fs.writeFileSync('/tmp/wizard-walk-all.txt', sorted.join('\n'));
console.error(`\nSaved ${sorted.length} unique strings to /tmp/wizard-walk-all.txt`);
console.error(`Screenshots in /tmp/wizard-step*.png`);
