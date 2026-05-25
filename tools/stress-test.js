#!/usr/bin/env node
// P2 stress + loader integration (historical). Loads the extension into a fresh
// Chromium, authenticates via cookie jar, forces lang=en via the `data-bt-lang`
// hook, then hammers the invoice editor with DOM churn while asserting the page
// stays responsive. The original P2 run also captured `data-bt-counters`
// (volatile / circuitBreaks); that publisher was removed alongside dev-mode in
// v1.0, so this tool now only measures responsiveness (alive + RTT).
//
// Usage: node tools/stress-test.js <netscape-cookie-jar.txt>

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jar = process.argv[2];
if (!jar) { console.error('usage: node tools/stress-test.js <cookie-jar>'); process.exit(1); }

function parseJar(p) {
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const a = line.split('\t'); if (a.length < 7) continue;
    const [domain, , pp, secure, , name, value] = a; if (!name) continue;
    out.push({ name, value, url: `https://${domain.replace(/^\./, '')}${pp}`,
      httpOnly: name.toLowerCase() === 'laravel_session', secure: secure.toLowerCase() === 'true', sameSite: 'Lax' });
  }
  return out;
}

async function main() {
  const cached = '/home/alex/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  const profile = '/tmp/bt-stress-profile';
  fs.rmSync(profile, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: fs.existsSync(cached) ? cached : undefined,
    args: [`--disable-extensions-except=${PROJECT_DIR}`, `--load-extension=${PROJECT_DIR}`, '--no-sandbox'],
    viewport: { width: 1366, height: 1000 },
  });
  await ctx.addInitScript(() => {
    const set = () => { if (document.documentElement) {
      document.documentElement.setAttribute('data-bt-lang', 'en'); } };
    set(); new MutationObserver((_, o) => { if (document.documentElement) { set(); o.disconnect(); } })
      .observe(document, { childList: true, subtree: true });
  });
  await ctx.addCookies(parseJar(jar));
  const page = await ctx.newPage();

  await page.goto('https://app.billingo.hu/n/document/create/invoice', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // Churn: repeatedly open/close every v-select dropdown for ~10s.
  const deadline = Date.now() + 10000;
  let cycles = 0;
  while (Date.now() < deadline) {
    const n = await page.locator('.vs__dropdown-toggle').count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 12); i++) {
      await page.locator('.vs__dropdown-toggle').nth(i).click({ timeout: 1500 }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
    }
    cycles++;
  }

  // Responsiveness probe: the page must still execute JS promptly.
  const t0 = Date.now();
  const alive = await page.evaluate(() => 1 + 1).catch(() => null);
  const rtt = Date.now() - t0;

  const counters = await page.evaluate(() => {
    const a = document.documentElement.getAttribute('data-bt-counters');
    return a ? JSON.parse(a) : null;
  });

  console.log(JSON.stringify({ cycles, alive, rttMs: rtt, counters }, null, 2));
  await ctx.close();

  if (alive !== 2 || rtt > 2000) { console.error('STRESS FAIL: page unresponsive'); process.exit(1); }
  console.error('STRESS OK: page responsive after churn');
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
