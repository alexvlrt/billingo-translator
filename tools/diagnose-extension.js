#!/usr/bin/env node
// Headless extension diagnostic. Loads the Billingo Translator into a fresh
// Chromium profile, authenticates with cookies, navigates several real
// authenticated pages, and reports for each: how many HU strings remain
// visible after the extension has translated.
//
// For each remaining HU string it classifies as either:
//   - DICT_HIT_BUT_STILL_HU → the dict has it but the extension didn't apply it (BUG)
//   - NOT_IN_DICT           → coverage gap, should be added to the dictionary
//
// Usage: node tools/diagnose-extension.js <netscape-cookie-jar.txt>

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { zoneForRoute } from './zones.js';

const cookieJarPath = process.argv[2];
if (!cookieJarPath) {
  console.error('usage: node tools/diagnose-extension.js <cookie-jar>');
  process.exit(1);
}

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Load _common + the route's zone shard (mirrors the P2 runtime loader and
// validates the shard output format produced by build-shards.js).
function loadShardedDict(route) {
  const dir = path.join(PROJECT_DIR, 'dict/en');
  const common = JSON.parse(fs.readFileSync(path.join(dir, '_common.json'), 'utf8'));
  const zone = zoneForRoute(route);
  let zoneDict = {};
  if (zone && fs.existsSync(path.join(dir, `${zone}.json`))) {
    zoneDict = JSON.parse(fs.readFileSync(path.join(dir, `${zone}.json`), 'utf8'));
  }
  return { ...common, ...zoneDict };
}

function parseNetscapeJar(p) {
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, , pp, secure, , name, value] = parts;
    out.push({
      name,
      value,
      url: `https://${domain.replace(/^\./, '')}${pp}`,
      httpOnly: name.toLowerCase() === 'laravel_session',
      secure: secure.toLowerCase() === 'true',
      sameSite: 'Lax',
    });
  }
  return out;
}

// Default: just the wizard for fast iteration. Override with a CLI arg — a comma
// separated list, so a full sweep reuses one browser instead of paying the ~30 s
// Chromium launch once per route.
const ROUTES = process.argv[3]
  ? process.argv[3].split(',').map((r) => r.trim()).filter(Boolean)
  : [
      '/n/bob/connection-wizard',
      '/n/bob/connection-wizard/1',
      '/n/bob/connection-wizard/2',
      '/n/bob/connection-wizard/3',
    ];

// Detection: a string is "potentially HU" if either (a) it has a Hungarian
// diacritic, or (b) it is a known HU source string in our dict (proof we
// already saw it as HU during catalog extraction).
const HU_RE = /[őűáéíóöúüŐŰÁÉÍÓÖÚÜ]/;
// Recomputed per route from the loaded shard (see loop in main()).
let dictKeys = new Set();
let dictValues = new Set();
function isLikelyHu(s) {
  // A string equal to a known translation we emitted is correct output, even
  // if it retains a HU proper noun (NAV Online Számla, Céginfó, KAÜ…). Check
  // this BEFORE the diacritic test so such translations aren't false-flagged.
  if (dictValues.has(s)) return false;
  if (HU_RE.test(s)) return true;
  if (dictKeys.has(s)) return true;
  // All-ASCII string not in dict.values (i.e. not one of our translations).
  // Drop pure numeric / data values.
  if (/^[\d\s.,:/\-+()%€$£¥]+$/.test(s)) return false;
  if (s.length < 3) return false;
  return false;
}

// `chrome-headless-shell` IGNORES --load-extension, without a warning: the run then
// measures a browser with no extension and reports every translated string as a bug.
// This whole tool once produced a 76-entry "bug list" that way, because the path it
// pinned (chromium-1208) had been garbage-collected by a playwright upgrade and the
// fallback was `undefined` — which resolves to the headless shell. So: find the FULL
// browser, take the newest build, and refuse to run rather than measure nothing.
function resolveFullChromium() {
  const root = path.join(process.env.HOME ?? '', '.cache/ms-playwright');
  const builds = fs.existsSync(root)
    ? fs.readdirSync(root)
      // chromium_headless_shell-* also starts with "chromium", hence the dash.
      .filter((d) => /^chromium-\d+$/.test(d))
      .map((d) => ({ dir: d, build: Number(d.split('-')[1]) }))
      .sort((a, b) => b.build - a.build)
    : [];
  for (const { dir } of builds) {
    const exe = path.join(root, dir, 'chrome-linux64/chrome');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error(
    'no full Chromium found under ~/.cache/ms-playwright (only the headless shell, '
    + 'which silently ignores --load-extension). Run: npx playwright install chromium');
}

async function main() {
  const cookies = parseNetscapeJar(cookieJarPath);
  const profileDir = '/tmp/bt-diag-profile';
  fs.rmSync(profileDir, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    executablePath: resolveFullChromium(),
    args: [
      `--disable-extensions-except=${PROJECT_DIR}`,
      `--load-extension=${PROJECT_DIR}`,
      '--no-sandbox',
    ],
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  // Force lang=en for every page via initScript: the extension's content
  // script honors `data-bt-lang` on the root element.
  await context.addInitScript(() => {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-bt-lang', 'en');
    }
    // For pages where document.documentElement isn't available at script-run,
    // observe and set as soon as <html> exists.
    new MutationObserver((_, obs) => {
      const html = document.documentElement;
      if (html) {
        html.setAttribute('data-bt-lang', 'en');
        obs.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });

  await context.addCookies(cookies);

  const commonSize = Object.keys(
    JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'dict/en/_common.json'), 'utf8'))
  ).length;
  console.log(`# Diagnostic — sharded dict, _common has ${commonSize} entries\n`);

  let totalHuFound = 0;
  let totalDictHits = 0;
  let totalNotInDict = 0;
  const allDictHits = new Set();
  const allMisses = new Set();

  const page = await context.newPage();

  for (const route of ROUTES) {
    const dict = loadShardedDict(route);
    dictKeys = new Set(Object.keys(dict));
    dictValues = new Set(Object.values(dict));
    const url = `https://app.billingo.hu${route}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Wait for network idle then give the extension's MutationObserver
      // a beat to translate any post-hydration content.
      await page
        .waitForLoadState('networkidle', { timeout: 15000 })
        .catch(() => {});
      await page.waitForTimeout(3000);
      // Try scrolling to the bottom to trigger lazy-rendered content.
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(1000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(800);

      const result = await page.evaluate(() => {
        const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
        const found = new Set();
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
        while ((n = tw.nextNode())) found.add(n.nodeValue.trim());
        // attributes
        const ew = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let el = ew.nextNode();
        while (el) {
          if (!SKIP.has(el.nodeName)) {
            for (const a of ['placeholder', 'title', 'aria-label', 'alt']) {
              const v = el.getAttribute && el.getAttribute(a);
              if (v && v.trim()) found.add(v.trim());
            }
          }
          el = ew.nextNode();
        }
        return [...found];
      });

      const huStrings = result.filter(isLikelyHu);
      // A "real bug" only if the translated value DIFFERS from the original.
      // Many entries are identity translations (Business→Business, Stripe→Stripe)
      // and are correctly applied even though they look unchanged.
      const dictHitsStillHu = huStrings.filter((s) => s in dict && dict[s] !== s);
      const notInDict = huStrings.filter((s) => !(s in dict));

      console.log(`## ${route}`);
      console.log(`  visible strings: ${result.length}`);
      console.log(`  HU-shaped:       ${huStrings.length}`);
      console.log(`  dict hits still in HU (BUG): ${dictHitsStillHu.length}`);
      console.log(`  NOT in dict (coverage gap):   ${notInDict.length}`);
      if (dictHitsStillHu.length > 0) {
        console.log('  Sample BUG entries (first 5):');
        for (const s of dictHitsStillHu.slice(0, 5)) {
          console.log(`    HU="${s}" → dict.en="${dict[s]}"`);
        }
      }
      console.log('');

      totalHuFound += huStrings.length;
      totalDictHits += dictHitsStillHu.length;
      totalNotInDict += notInDict.length;
      for (const s of dictHitsStillHu) allDictHits.add(s);
      for (const s of notInDict) allMisses.add(s);
    } catch (err) {
      console.log(`## ${route} — error: ${err.message}\n`);
    }
  }

  console.log('# Summary');
  console.log(`  HU-shaped strings seen across all pages: ${totalHuFound}`);
  console.log(`  Dict-hit-but-still-HU (BUG):              ${totalDictHits} unique=${allDictHits.size}`);
  console.log(`  Not-in-dict (coverage gap):               ${totalNotInDict} unique=${allMisses.size}`);

  const summary = {
    pages: ROUTES.length,
    dictSize: commonSize,
    bugStrings: [...allDictHits].sort(),
    coverageGaps: [...allMisses].sort(),
  };
  fs.writeFileSync(
    path.join(PROJECT_DIR, 'tools/diagnostic-output.json'),
    JSON.stringify(summary, null, 2)
  );
  console.log('Detailed output saved to tools/diagnostic-output.json');

  await context.close();
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
