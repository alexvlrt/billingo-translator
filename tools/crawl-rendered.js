#!/usr/bin/env node
// Headless playwright crawler that renders each authenticated Billingo page
// (Vue/Nuxt SPA, post-hydration) and extracts every visible HU string plus
// translatable attributes — much richer than SSR-only curl extraction.
//
// Usage: node tools/crawl-rendered.js <netscape-cookie-jar.txt> > tools/rendered-strings.txt

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { extractRenderedStrings } from './snapshot-walker.js';
import { zoneForRoute } from './zones.js';

const cookieJarPath = process.argv[2];
if (!cookieJarPath) {
  console.error('usage: node tools/crawl-rendered.js <netscape-cookie-jar.txt>');
  process.exit(1);
}

// Parse Netscape cookie jar into the format playwright expects.
function parseNetscapeJar(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const cookies = [];
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, _flag, p, secure, _expiry, name, value] = parts;
    const cleanDomain = domain.replace(/^\./, '');
    cookies.push({
      name,
      value,
      url: `https://${cleanDomain}${p}`,
      httpOnly: name.toLowerCase() === 'laravel_session',
      secure: secure.toLowerCase() === 'true',
      sameSite: 'Lax',
    });
  }
  return cookies;
}

// Routes to crawl (mirrors tools/crawl-routes.txt minus :params and admin).
const ROUTES = [
  // Auth surface (no login needed, but content is visible)
  '/auth/login',
  '/auth/registration',
  '/auth/password-reset',
  // Nuxt SPA (the main authenticated app)
  '/n/dashboard',
  '/n/document/invoice/list',
  // Invoice/document editor — real route is /n/document/create/<type>
  // (NOT /n/document/<type>/create, which 404s). Discovered via the
  // dashboard "Új bizonylat kiállítás" link.
  '/n/document/create/invoice',
  '/n/document/create/offer',
  '/n/document/create/order-form',
  '/n/document/create/waybill',
  '/n/document/create/certification-of-completion',
  '/n/document/cases/offer/list',
  '/n/document/cases/order-form/list',
  '/n/document/cases/waybill/list',
  '/n/document/cases/certification-of-completion/list',
  '/n/document/dossier/list',
  '/n/document-block/list',
  '/n/document-comment/list',
  '/n/document-export',
  '/n/document-import/list',
  '/n/document-import/create',
  '/n/document-notification/list',
  '/n/document-notification/create',
  '/n/document-reminder/list',
  '/n/document-reminder/create',
  '/n/external-invoice-import',
  '/n/partner/list',
  '/n/partner/create',
  '/n/partner/upload',
  '/n/partner/bulk-edit',
  '/n/product/list',
  '/n/product/create',
  '/n/product/upload',
  '/n/product/bulk-edit',
  '/n/product/sales',
  '/n/spending/list',
  '/n/spending/create',
  '/n/bank-account/list',
  '/n/bank-account/create',
  '/n/bob/dashboard',
  '/n/bob/transaction/list',
  '/n/bob/spending-payment/list',
  '/n/bob/activity-log/list',
  '/n/bob/bank-status',
  '/n/ceginfo/search',
  '/n/ceginfo/watch',
  '/n/inventory/settings/defaults',
  '/n/inventory/settings/site/list',
  '/n/organization-place/list',
  '/n/organization-setting/company-data',
  '/n/organization-setting/document',
  '/n/organization-setting/online-szamla-email',
  '/n/nav-online-szamla/settings',
  '/n/marketplace/third-party',
  '/n/user/account',
  '/n/user/colleague/list',
  '/n/user/role/list',
  '/n/user/security/password-and-email',
  '/n/user/security/tfa',
  '/n/user/security/trusted-devices',
  '/n/user/security/notification',
  '/n/user-invitation/list',
  '/n/subscription/overview',
  '/n/subscription/recommended-plans',
  '/n/subscription/transactions-and-data',
  '/n/affiliate',
  '/n/accountant-affiliate',
  '/n/campaign-manager/list',
  '/n/campaign-manager/create',
  '/n/tender-monitor/list',
  '/n/tender-monitor/settings',
  '/n/tender-monitor/subscription',
  '/n/flat-tax/assistant',
  '/n/flat-tax/settings',
  '/n/flat-tax/knowledge-base',
  '/n/kata/assistant',
  '/n/kata/settings',
  '/n/phone-validate',
];

async function main() {
  const cookies = parseNetscapeJar(cookieJarPath);
  console.error(`Loaded ${cookies.length} cookies, launching headless Chromium…`);

  // Use the chromium binary already cached on disk (avoids npx playwright install).
  const cachedChromium =
    '/home/alex/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(cachedChromium) ? cachedChromium : undefined,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies(cookies);

  const perRoute = new Map();
  const page = await context.newPage();

  for (let i = 0; i < ROUTES.length; i++) {
    const route = ROUTES[i];
    const url = `https://app.billingo.hu${route}`;
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(600);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      const status = res ? res.status() : '?';

      const found = await page.evaluate(extractRenderedStrings);

      perRoute.set(route, found);
      console.error(
        `[${i + 1}/${ROUTES.length}] ${status} ${route} → +${found.length}`
      );
    } catch (err) {
      console.error(`[${i + 1}/${ROUTES.length}] ERROR ${route}: ${err.message}`);
    }
  }

  await browser.close();

  // Escape backslash/tab/newline so multi-line text nodes survive as one TSV
  // line. The runtime translates the trimmed nodeValue *with* internal newlines
  // preserved (see src/dom-walker.js translateTextNode), so we must keep them
  // intact for keys to match. build-shards.js readObserved reverses this.
  const esc = (s) =>
    s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  const lines = [];
  for (const [route, strings] of perRoute) {
    const zone = zoneForRoute(route) || '_common';
    for (const s of strings) lines.push(`${zone}\t${esc(s)}`);
  }
  fs.mkdirSync('tools/capture', { recursive: true });
  fs.writeFileSync('tools/capture/sweep.tsv', lines.join('\n') + '\n');
  console.error(`Wrote tools/capture/sweep.tsv (${lines.length} lignes)`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
