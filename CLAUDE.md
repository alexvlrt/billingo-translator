# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

An **unofficial** MV3 browser extension (Chrome/Edge + Firefox) that translates the
Hungarian-only Billingo invoicing UI (`app.billingo.hu`) into English or French,
live and in place. There is **no backend**: a static, hand-curated dictionary ships
inside the extension and a content script substitutes text nodes and a few
attributes in the DOM.

Two halves, with different rules:

| Half | Path | Module system | Ships to users |
| --- | --- | --- | --- |
| Runtime extension | `src/`, `dict/`, `manifest.json`, `icons/` | **classical scripts** (no ESM) | yes |
| Build/capture pipeline | `tools/`, `scripts/` | **ESM** (`"type": "module"`) | no |

## Commands

```bash
npm install                                  # jsdom, acorn, playwright (required for tests)
npm test                                     # node:test over tests/**/*.test.js

node tools/extract-bundle.js <cookie-jar>    # Nuxt bundle → HU strings → tools/capture/bundle.tsv
node tools/crawl-rendered.js <cookie-jar>    # passive route sweep → tools/capture/sweep.tsv
node tools/crawl-interactive.js <cookie-jar> # dropdowns/editor states → tools/capture/interactive.tsv
node tools/build-shards.js                   # capture/*.tsv + dict/{en,fr}.json → dict/<lang>/*.json
node tools/diagnose-extension.js <cookie-jar># load the extension for real, report residual HU strings
node scripts/build-icons.mjs                 # needs `npm i sharp` ad hoc; not a project dependency
```

`<cookie-jar>` is a Netscape-format jar for an authenticated Billingo session. It is
never committed; without it the capture tools cannot run.

## Runtime architecture

Load order is fixed by `manifest.json` → `content_scripts.js`; each file is an IIFE
that publishes onto `globalThis.BillingoTranslator`. **Never add `import`/`export` to
`src/`** — Chrome evaluates these as classical scripts and tests load them through
`vm` (`tests/load-script.js`).

| File | Responsibility |
| --- | --- |
| `src/translator.js` | Layered lookup (exact → whitespace → punctuation → patterns) + hit/miss stats. No DOM, no `chrome.*`. |
| `src/dom-walker.js` | TreeWalker over text nodes + translatable attributes; remembers originals; `MutationObserver`. |
| `src/shard-loader.js` | Route → zone → lazy `fetch(dict/<lang>/<zone>.json)`, merged into one object, load-and-keep. `ensureAll()` sweeps every zone. |
| `src/spa-router.js` | Detects SPA navigation (polling is the reliable path — see below). |
| `src/content.js` | Wiring, storage, popup messaging, monolithic-dict fallback. |
| `src/popup.{html,js,css}` | Language radiogroup + live coverage %. |

### Invariants you must not break

These exist because a naive implementation froze the real Billingo app. Changing
`src/dom-walker.js` without preserving all of them is a regression:

- **Originals are stashed in WeakMaps** (`originalText`, `originalAttrs`) so language
  switching and restore-to-Hungarian work with no reload.
- **`ourTextWrites` / `ourAttrWrites` guard** — the observer must ignore mutations we
  caused, otherwise it loops on its own output.
- **No-op-by-equality** — never assign a value equal to the current one; this is what
  makes re-walking idempotent and safe to run concurrently with the observer.
- **Time slicing** (`runSliced`, `SLICE_SIZE`) — `walkAndTranslate` may return *before*
  finishing. Callers must not assume synchronous completion.
- **`walkGen`** — a newer full walk aborts an older one. Mutation processing passes no
  `gen`: it is incremental and must neither cancel nor be cancelled by a full walk.
- **Volatile-node cap** (`RETRANSLATE_CAP` within `RETRANSLATE_WINDOW_MS`) — a node the
  framework keeps reverting is abandoned. Only *external* reverts count, so a user
  switching languages never trips it.
- **Flood circuit-breaker** (`FLOOD_THRESHOLD` records/s → disconnect, cooldown, resettle).
- **Empty dictionary value means miss**, never blank output — an untranslated key
  (`""`) must leave the Hungarian text visible. This holds at every lookup layer.

### Lookup layers (`src/translator.js`)

Exact match is layer 1; everything after it exists because Billingo renders text
the dictionary cannot hold verbatim (indentation, `Adószám` vs `Adószám:`,
`:type` substitution, `3 db` vs `17 db`). Layers 1 and 3 read the dictionary
live; layers 2 and 4 use a derived index built lazily on the first miss.

**`translate.refresh()` must be called whenever the shard loader merges a new
zone**, or the pattern index goes stale. `src/content.js` does this after
`ensureZoneForRoute` (only when it returned `true`) and after `ensureAll`.
Rebuilding is a full dictionary pass (~30 ms over ~8 k keys), so do not call it
per route change unconditionally.

### Other runtime facts

- A content script runs in an **isolated world**, so patching `history.pushState` does
  not intercept the page's own navigations. `src/spa-router.js` **polls**
  `location.pathname`; `popstate`/`pushState` are best-effort fast paths only.
- `globalThis.browser ?? globalThis.chrome` is the cross-browser API shim. Keep it.
- Permissions are deliberately minimal: `storage` + `host_permissions` on
  `app.billingo.hu` only. **No runtime network requests, no analytics, no telemetry** —
  see `PRIVACY.md`. Do not add a permission without an explicit reason.
- `<html data-bt-lang="en">` forces a language; it is the hook used by
  `tools/diagnose-extension.js` and `tools/stress-test.js`.

## Dictionary & build pipeline

Route → zone mapping lives in **`tools/zones.js` (single source of truth)** and is
compiled into `dict/_index.json`, sorted longest-prefix-first.

**Source of truth for translations is `dict/en.json` + `dict/fr.json`** (monolithic).
`dict/en/*.json` and `dict/fr/*.json` are **generated** — `tools/build-shards.js`
does `fs.rmSync(dir, {recursive: true})` before rewriting them. Hand-edits to a shard
are destroyed on the next build.

Workflow to add coverage:

1. Add `"<hungarian>": "<translation>"` to `dict/en.json` **and** `dict/fr.json`.
2. Run `node tools/build-shards.js`.
3. Record any non-obvious fiscal/legal choice in `TRANSLATIONS.md` (dated entry).

> ⚠️ **Footgun: `build-shards.js` needs `tools/capture/*.tsv`, which is gitignored.**
> On a fresh clone the capture dir is empty, so every key resolves to zero observed
> zones and the whole dictionary collapses into a single `_common.json` — the 20 other
> shards are deleted. Re-run the capture tools (needs an authenticated cookie jar), or
> restore `tools/capture/` first. Never run it blind on a clean checkout.

Filters (`tools/lib/filters.js`) are shared by the capture tools:
`looksLikeNoise` rejects code-shaped tokens; `makeHuFilter` keeps a string only if it
carries a Hungarian diacritic or is already a dictionary key. Existing keys bypass both
filters, so a manually added accent-less key survives re-sharding.

## Testing

`node:test` + `assert`. Pure logic is tested directly; DOM code runs under jsdom;
`src/*.js` is loaded via `tests/load-script.js` (`vm`) because it has no exports.
Tests are the only automated safety net — there is no lint, type-check, or CI.
Add a test for any change to the walker, the loader, the router, or the filters.

## Safety when crawling Billingo

`app.billingo.hu` is a **production invoicing app wired to NAV** (the Hungarian tax
authority), not a sandbox. Capture tooling must stay **strictly read-only**: open
dropdowns, add a client-side line item, then Escape. Never click a commit control —
no document issue, no draft save, no wizard "Tovább" (can start a real bank link), no
delete/confirm. This constraint is documented at the top of
`tools/crawl-interactive.js`; preserve it in any new tool.

## Conventions

- Comments in `src/` are English; several `tools/` files are commented in French —
  match the file you are editing rather than converting it.
- Every non-trivial behaviour carries a *why* comment. Keep that density.
- Console output in the runtime uses a `[bt]` / `[billingo-translator]` prefix and is
  limited to genuine warnings/errors.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:` …), scoped where useful
  (`feat(dict):`, `feat(runtime):`).
- Trademark stance: this is an unofficial, unaffiliated tool. Keep that disclaimer
  intact in user-facing text.

## Known gaps (do not "rediscover" these)

- `/auth/*` (login, registration, password reset) has no zone and is explicitly
  excluded from bundle extraction (`EXCLUDE` in `tools/extract-bundle.js`) —
  effectively untranslated beyond `_common`.
- `content.js` tracks `uniqueMisses` and answers `getStats`, but nothing surfaces
  them: the popup shows only a percentage. There is no way for a user to export
  the strings they saw untranslated, so real-world misses are never harvested.
- `makeHuFilter` keeps a captured string only if it carries a Hungarian diacritic
  or is already a key, so **accent-less Hungarian is invisible to fresh DOM
  captures** (555 shipped keys have no diacritic; they survived via the bundle's
  i18n catalog, not the DOM sweep).
- Interaction-gated text — validation errors, toasts, confirm dialogs — is out of
  reach of the crawlers, which are read-only against a production NAV-connected
  account. A dedicated trial account would unlock this class.
- ~167 keys are extraction garbage (HTML attribute residue such as
  `" class="font-weight-bold" style="…">Megrendelések`). They can never match and
  they weigh on `_common` (596 KB), which is parsed on every page.
