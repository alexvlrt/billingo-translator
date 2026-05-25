#!/usr/bin/env node
// Interactive Playwright capture (Task 7, Playwright variant of the planned MCP
// pass): drives the authenticated Billingo SPA through interaction-gated states
// — invoice-editor line items, v-select dropdowns (VAT/unit/currency/payment),
// form-validation errors, and the bank-sync wizard — and records every rendered
// HU string, tagged by zone, to tools/capture/interactive.tsv.
//
// Headless + cookie-jar authenticated (no live browser needed).
//
// SAFETY — this drives a PRODUCTION pro-invoicing app wired to NAV (HU tax
// authority), NOT a sandbox. STRICTLY read-only interactions only:
//   - open v-select dropdowns (reveal options) then Escape — no selection;
//   - add an invoice line row (client-side form state only, never persisted).
// It NEVER clicks any commit control: no "Bizonylat létrehozása" (issue doc),
// no "Piszkozat" (save draft), no wizard "Tovább" (could start a real bank
// connection), no delete/confirm modals, no "create case". Nothing is written
// server-side; no document is issued; no bank is authorized.
//
// Usage: node tools/crawl-interactive.js <netscape-cookie-jar.txt>

import { chromium } from 'playwright';
import fs from 'node:fs';
import { extractRenderedStrings } from './snapshot-walker.js';

const cookieJarPath = process.argv[2];
if (!cookieJarPath) {
  console.error('usage: node tools/crawl-interactive.js <netscape-cookie-jar.txt>');
  process.exit(1);
}

function parseNetscapeJar(filePath) {
  const cookies = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, , p, secure, , name, value] = parts;
    if (!name) continue;
    cookies.push({
      name, value,
      url: `https://${domain.replace(/^\./, '')}${p}`,
      httpOnly: name.toLowerCase() === 'laravel_session',
      secure: secure.toLowerCase() === 'true',
      sameSite: 'Lax',
    });
  }
  return cookies;
}

const esc = (s) =>
  s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');

async function main() {
  const cachedChromium = '/home/alex/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(cachedChromium) ? cachedChromium : undefined,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 1000 },
  });
  await context.addCookies(parseNetscapeJar(cookieJarPath));
  const page = await context.newPage();

  // zone -> Set<string>
  const perZone = new Map();
  async function snap(zone, label) {
    try {
      const found = await page.evaluate(extractRenderedStrings);
      const set = perZone.get(zone) || new Set();
      for (const s of found) set.add(s);
      perZone.set(zone, set);
      console.error(`  [${zone}] ${label}: +${found.length} (zone total ${set.size})`);
    } catch (e) {
      console.error(`  [${zone}] ${label}: snap failed ${e.message}`);
    }
  }
  const goto = async (route) => {
    await page.goto(`https://app.billingo.hu${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1800);
  };
  const clickText = async (text, label) => {
    try {
      await page.getByText(text, { exact: false }).first().click({ timeout: 4000 });
      await page.waitForTimeout(900);
      return true;
    } catch (e) { console.error(`    click "${label || text}" skipped: ${e.message.split('\n')[0]}`); return false; }
  };

  // Open every Vue v-select dropdown once, snapshotting the revealed option list.
  async function openAllDropdowns(zone) {
    let n = 0;
    try { n = await page.locator('.vs__dropdown-toggle').count(); } catch {}
    for (let i = 0; i < Math.min(n, 14); i++) {
      try {
        const tog = page.locator('.vs__dropdown-toggle').nth(i);
        await tog.scrollIntoViewIfNeeded({ timeout: 2000 });
        await tog.click({ timeout: 3000 });
        await page.waitForTimeout(450);
        await snap(zone, `dropdown ${i + 1}/${Math.min(n, 14)}`);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(150);
      } catch (e) { /* skip toggles that don't open */ }
    }
  }

  // ---- Invoice editor (zone: documents) ----
  console.error('== Invoice editor /n/document/create/invoice ==');
  await goto('/n/document/create/invoice');
  await snap('documents', 'initial');
  await clickText('Új tétel hozzáadása', 'add line item');
  await snap('documents', 'after add item');
  await openAllDropdowns('documents');
  // NOTE: deliberately NO submit/draft click — issuing or drafting a document
  // would write to a production NAV-connected account. Validation strings are
  // out of scope for safety reasons.

  // ---- Other document editor types that rendered empty in the passive sweep ----
  for (const t of ['offer', 'order-form', 'waybill', 'certification-of-completion']) {
    console.error(`== Editor /n/document/create/${t} ==`);
    await goto(`/n/document/create/${t}`);
    await snap('documents', `${t} initial`);
    await clickText('Új tétel hozzáadása', 'add line item');
    await snap('documents', `${t} after add item`);
    await openAllDropdowns('documents');
  }

  // ---- Bank-sync wizard (zone: bank) ----
  console.error('== Bank wizard /n/bob/connection-wizard ==');
  await goto('/n/bob/connection-wizard');
  await snap('bank', 'wizard initial');
  // Open the country/bank selects to reveal their lazy option lists — but do
  // NOT click "Tovább": advancing the wizard could initiate a real bank link.
  await openAllDropdowns('bank');

  await browser.close();

  // Write tools/capture/interactive.tsv
  const lines = [];
  for (const [zone, set] of perZone) for (const s of set) lines.push(`${zone}\t${esc(s)}`);
  fs.mkdirSync('tools/capture', { recursive: true });
  fs.writeFileSync('tools/capture/interactive.tsv', lines.join('\n') + '\n');
  console.error(`Wrote tools/capture/interactive.tsv (${lines.length} lignes)`);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
