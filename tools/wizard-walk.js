#!/usr/bin/env node
// Walk the bank-sync wizard READ-ONLY: select country/bank to reveal lazy
// content. Stops short of any "authorize" / "redirect" action. Captures all
// HU strings that appear during interaction.

import { chromium } from 'playwright';
import fs from 'node:fs';

const cookieFile = process.argv[2] || '/tmp/billingo-crawl/jar.txt';

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

async function snapshot(page) {
  return await page.evaluate(() => {
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
}

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
await context.addCookies(loadCookies(cookieFile));

const all = new Set();
const page = await context.newPage();
// Track network: each new XHR / chunk fetch may pull more JS chunk URLs.
const chunkUrls = new Set();
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('/nuxt/') && url.endsWith('.js')) chunkUrls.add(url);
});

console.error('Loading wizard step 1…');
await page.goto('https://app.billingo.hu/n/bob/connection-wizard/1', {
  waitUntil: 'networkidle', timeout: 30000,
}).catch(() => {});
await page.waitForTimeout(3000);

let s = await snapshot(page);
for (const x of s) all.add(x);
console.error(`After load: ${all.size} strings`);

// Select Hungary (the country dropdown).
const countries = ['Magyarország', 'Románia', 'Szlovákia', 'Ausztria'];
for (const country of countries) {
  console.error(`Trying country: ${country}`);
  try {
    // Find a clickable element with the country name. Try buttons, divs, etc.
    const elt = await page.$(`text=${country}`);
    if (!elt) { console.error(`  no element matched`); continue; }
    await elt.scrollIntoViewIfNeeded();
    await elt.click({ timeout: 3000 });
    await page.waitForTimeout(2500);
    s = await snapshot(page);
    for (const x of s) all.add(x);
    console.error(`  After click ${country}: ${all.size} strings`);

    // After selecting country, banks list appears. Click each bank one by one.
    // Pick a few common ones — text-locator only, no inputs.
    const banks = ['OTP', 'K&H', 'Erste', 'Raiffeisen', 'MBH', 'Unicredit', 'Magnet', 'CIB', 'Takarékbank', 'Revolut', 'Wise', 'BinX'];
    for (const bank of banks) {
      try {
        const b = await page.$(`text=${bank}`);
        if (!b) continue;
        await b.click({ timeout: 2000 });
        await page.waitForTimeout(2500);
        s = await snapshot(page);
        for (const x of s) all.add(x);
        console.error(`    Bank ${bank}: ${all.size} strings`);
        // Try to find a back button or close to reset, otherwise just continue.
        const back = await page.$('[aria-label="Vissza"]') || await page.$('text=Vissza') || await page.$('text=Mégse');
        if (back) await back.click({ timeout: 2000 }).catch(()=>{});
        await page.waitForTimeout(1200);
      } catch (e) {
        // continue
      }
    }
    // Reset to country picker for next country
    await page.goto('https://app.billingo.hu/n/bob/connection-wizard/1', {
      waitUntil: 'networkidle', timeout: 20000,
    }).catch(() => {});
    await page.waitForTimeout(2000);
  } catch (e) {
    console.error(`  error on ${country}: ${e.message}`);
  }
}

await browser.close();

console.error(`\nTotal unique strings captured: ${all.size}`);
console.error(`Total chunk URLs requested: ${chunkUrls.size}`);

// Persist outputs.
fs.writeFileSync('/tmp/wizard-walk-strings.txt', [...all].sort((a,b)=>a.localeCompare(b,'hu')).join('\n'));
fs.writeFileSync('/tmp/wizard-walk-chunks.txt', [...chunkUrls].sort().join('\n'));
console.error('Saved /tmp/wizard-walk-strings.txt and /tmp/wizard-walk-chunks.txt');
