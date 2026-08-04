# Changelog

All notable changes to **Translator for Billingo** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-08-04

No change to what the extension does. This release exists because 1.0.0 shipped without
usable artifacts, and because installing on Chrome meant living in developer mode.

### Added

- **Permanent Chrome install without the Web Store.** `scripts/crx.mjs` signs the already
  validated Chrome payload into a CRX3 with the project's own RSA key, and emits
  `updates.xml` plus a policy bundle for Windows, Linux and macOS. Chrome refuses any
  extension no policy names, so both usable shapes ship: `ExtensionInstallForcelist`
  (Chrome fetches, installs and updates it; the user cannot remove it) and
  `ExtensionInstallAllowlist` (unblocks the ID only, manual install, no auto-update).
  Forcelist is viable here because this repository is public — Chrome's updater cannot
  authenticate, so a private repo's release assets would be unreachable to it.
- The real extension ID is baked into every policy file at build time. A placeholder that
  reaches a machine fails as an extension that simply never appears, with no error to trace.
- The CRX3 writer is hand-rolled, like the ZIP writer beside it, and verified byte-for-byte
  against `google-chrome --pack-extension` on the same key: identical `crx_id`, public key,
  protobuf field numbers and signature length. 22 tests cover the format, signature
  verification over a reconstructed payload, and key rejection (non-RSA, undersized, public
  half, unparseable).

### Fixed

- **A tag push read the workflow from the tagged commit**, so `v1.0.0` — placed on a commit
  predating `release.yml` — fired nothing at all: no run, no failure, no notification. The
  only run that did execute was a `workflow_dispatch`, which defaults to a dry run. Between
  them, the first release produced neither a signed `.xpi` nor a Chrome package. Now
  documented in the workflow header, where someone about to tag will read it.
- **`gh release create` failed when the tag already carried a release** — and it ran *after*
  AMO had signed, so an error at the last step stranded the one artifact that cannot be
  rebuilt: a signed `.xpi` whose version number is burnt and cannot be reused. It now uploads
  into the existing release, keeping its notes.

### Changed

- The README leads with the permanent install for both browsers, straight from the release
  page. Building locally, hand-signing and releasing moved under Development — developer mode
  was reading as the normal way to install rather than the fallback.

## [1.0.0] — 2026-08-03

First public release. Nothing before this was ever published, so this entry describes the
whole extension rather than a delta; the development milestones that led here are kept
below under [Pre-release history](#pre-release-history).

Coverage, measured against Billingo's own Hungarian i18n catalog extracted from the app's
full Nuxt bundle, over the 5,655 segments the DOM actually renders: **97.8 %** in both
English and French. What is left untranslated is Laravel `:token` placeholders, bank brand
names, Billingo's own test fixtures and URLs — about 10 strings in the entire catalog are
arguably translatable.

### Added — what it does

- Live translation of the `app.billingo.hu` UI into **English** or **French**, in place, with
  no page reload.
- Instant language switching from the popup, including **restore to Hungarian**: the original
  text is remembered per node, so switching back is exact and needs no reload.
- **8,618 curated dictionary entries** per language, every one with a value in both — no blank
  entries, because a blank value means "miss" and would leave Hungarian on screen.
- Route-aware **sharded dictionary**: the shard for the current page loads first, then every
  remaining zone is prefetched once the page goes idle, so a partner modal inside the invoice
  editor or an upsell banner from another section is translated too. First paint is unaffected.
- SPA-aware navigation. A content script runs in an isolated world, so patching
  `history.pushState` cannot see the page's own navigations — the router **polls**
  `location.pathname`, with `popstate` as a best-effort fast path.
- Translation of text nodes plus `placeholder`, `title`, `aria-label`, `alt`,
  `aria-placeholder`, `aria-description`, `label`, and `value` on button-type inputs.
  A `textarea`'s **content** is never touched: that is user data. Its placeholder is.
- **The page title is translated** — the walk and the observer are rooted at
  `document.documentElement`, so `<title>` inside `<head>` is reached and the browser tab
  stops being Hungarian.
- **Export of the untranslated strings** from the popup (copy to clipboard, or download as
  JSON with the pathname and extension version). This is the only feedback loop from real
  usage back into the dictionary; the count of distinct misses sits next to the live coverage
  percentage.
- Chrome / Edge and Firefox from one codebase (Manifest V3), via the
  `globalThis.browser ?? globalThis.chrome` shim.

### Added — how the lookup goes beyond exact matches

Every layer past the first exists because Billingo renders text a dictionary cannot hold
verbatim. Execution order is most-reliable-first, most-destructive-last:

1. **exact** — `dict['Számlák']`.
2. **whitespace** — indented, wrapped and NBSP-separated text; also Unicode NFC, so the two
   non-NFC strings the app ships can match.
3. **trailing punctuation** — a label shipped as `Adószám` also matches `Adószám:`, and
   `Figyelem` matches `Figyelem!`, keeping the punctuation in the output. In French the space
   before `! ? ; »` is re-composed, matching the U+0020 the curated values use.
4. **case variant** — `bezárás` and `TÖRLÉS` both match a Title-case entry, and the reply is
   re-cased to match the source.
5. **`:token` templates** — `:type letöltése` fills from the rendered text and translates the
   captured fragment (`Számla letöltése` → `Télécharger la facture`).
6. **numeric templates** — `3 db` generalises to any number (`17 db` → `17 pièces`), preferring
   the plural source pair.
7. **parenthetical tail** — `Cím (opcionális)` composed from `Cím` + `opcionális`.
8. **separator split** — `Kelt / Fizetve`, breadcrumbs, `Bejelentkezés - Billingo`.

Layers 7 and 8 only fire when **every letter-bearing part resolves**, which is what stops a
product named `Termék (Nagy)` from being rewritten. Measured over 84 k mutated probes derived
from the shipped keys, the layered translator resolves ~7× what exact matching alone does.

### Added — safeguards

A naive implementation froze the real app, so the DOM walker carries deliberate protections,
each covered by tests:

- Originals stashed in `WeakMap`s, so language switching and restore need no reload.
- Own-write guards, so the `MutationObserver` never loops on the translations it caused.
- No-op-by-equality, which makes re-walking idempotent and safe to run concurrently with the
  observer.
- Time-sliced walking; a newer full walk supersedes an older one, while incremental mutation
  processing neither cancels nor is cancelled by it.
- A per-node re-translation cap that abandons a node the framework keeps reverting — counting
  only *external* reverts, so a user switching language never trips it.
- A mutation-flood circuit-breaker that disconnects, cools down and re-settles.

### Added — fiscal safety

Billingo is wired to NAV, the Hungarian tax authority, so a rewritten amount is worse than
untranslated text.

- `tests/dict-fiscal-safety.test.js` runs the **real** dictionary through the real translator:
  amounts (including U+00A0 and U+202F groupings), tax identifiers, invoice serials, IBANs,
  dates, ranges, percentages and rendered Hungarian addresses must come out with their numbers
  intact; no value may be blank; no key listed in the denylist may still ship. Every other
  translator test builds a *synthetic* dictionary, which is exactly how a real defect once
  reached the tree (see the pre-release log).
- Address-type words (`utca`, `út`, `tér`, `park`, `rakpart`, …) are dictionary keys on
  purpose — they appear as standalone options in the address picker — and lookup is
  whole-text-node, so they never rewrite a word inside a rendered address.

### Added — build and packaging

- `npm run package` builds `dist/chrome/` and `dist/firefox/` plus one zip each, from an
  **allowlist** of the runtime files. It refuses to write anything when the payload is
  inconsistent: a missing content script, an icon or popup asset that would 404, a
  `web_accessible_resources` pattern matching no file, an ESM `import` that would stop Chrome
  evaluating a content script, or a shard named by `dict/_index.json` and absent in a language.
  Dependency-free (a ~60-line `zlib` ZIP writer), so it works offline.
- `npm run lint:ext` runs Mozilla's own `web-ext lint` over the Firefox payload: 0 errors,
  0 warnings, 0 notices.
- `tools/build-shards.js` is non-destructive and safe on a clean checkout. It rebuilds its zone
  baseline from the shards on disk, overlays `tools/capture/*.tsv` with per-key precedence, and
  refuses to shrink the shard set, to lose more than 10 % of either language's translations, or
  to run with neither shards nor a capture.
- `dict/_rejected.json`: a committed denylist of strings that must never become dictionary
  keys. Hygiene decisions previously lived nowhere, so every capture resurrected the same
  garbage (foreign date locales, TypeScript doc comments, demo-account names, internal
  fixtures, English strings captured on the key side).
- `tools/mine-html-keys.js` derives matchable per-segment pairs from the dictionary's own
  `v-html` keys, reusing translations already present.
- 291 tests (`node:test`, jsdom for DOM code, `vm` for the classical `src/` scripts).
- **CI** (`.github/workflows/ci.yml`) on every push to `main` and every pull request: install,
  test, package, and Mozilla's `web-ext lint`, with the packages attached as build artifacts.
- **Automated release** (`.github/workflows/release.yml`) on a `v*` tag: it tests, builds and
  lints *before* signing — a broken signed build cannot be corrected in place, because AMO
  refuses to reuse a version number. It then signs the Firefox add-on via
  `web-ext sign --channel unlisted`, optionally publishes the Chrome update, and attaches both
  artifacts to a GitHub Release. `workflow_dispatch` is a dry run by default, for validating the
  pipeline without burning a version. The tag must equal the manifest version, so a mismatch
  fails in seconds instead of surfacing as an opaque AMO rejection.
  <br>Firefox needs the `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` secrets and fails loudly without
  them. Chrome needs five `CHROME_*` secrets and the step **skips itself** when they are absent,
  so a Firefox-only setup needs no configuration — Chrome has no signing step at all, since the
  Web Store signs on publish and its API can only update an existing listing.
- `npm test` now globs `tests/*.test.js` (one level) instead of `tests/**/*.test.js`. The `**`
  form is expanded by neither POSIX `sh` nor bash without `globstar`, so it reached `node` as a
  literal and relied on the test runner's own glob support — a silent dependency on the Node
  version that would have broken CI on a different runner image. Same 23 files, same 291 tests.

### Manifest

- **Requires Firefox 127+.** Before 127, Firefox did not grant the host permission behind
  `content_scripts` at install time, so the add-on would install and then translate nothing,
  with no way for the user to tell why. The packaging step asserts this floor.
- `browser_specific_settings.gecko.data_collection_permissions` is declared as
  `{"required": ["none"]}` — accurate, and AMO will require the key.
- Permissions are deliberately minimal: `storage`, plus `host_permissions` on
  `https://app.billingo.hu/*`. **No network requests at runtime, no analytics, no telemetry.**
  See [`PRIVACY.md`](PRIVACY.md).

### Known limitations

- Layers 7 and 8 decompose arbitrary strings, so composite **user data** can be rewritten when
  every part happens to be a dictionary word: a product literally named `Javítás (Autó)`
  renders as "Correction (Car)", because the dictionary maps `Javítás` to the invoice-correction
  sense. The all-parts-must-resolve guard removes the unknown-word cases at a measured cost of
  0–0.4 points; closing the rest needs a container-level skip for line-item cells.
- A capture only keeps a string if it carries a Hungarian diacritic or is already a key, so
  **accent-less Hungarian is invisible to fresh DOM captures**. Those keys survive through the
  bundle's i18n catalog instead.
- A Bootstrap tooltip that was initialised *before* the first walk flashes Hungarian on its
  first pop-up, then self-heals. Translating the `data-original-title` stash would fix that
  flash but breaks live language switching, so it is deliberately left alone.
- `/auth/login` is served by a separate legacy front-end, not by the Nuxt app. Its visible
  strings are covered because they live in `_common`, but it has no zone of its own.

---

## Pre-release history

> None of the builds below was ever published. They are kept as the record of how the shipped
> behaviour was reached — particularly the defects, because each one is a trap worth not
> falling into twice.

### 2026-08-03 — coverage, correctness, packaging

Coverage went from **91.5 % to 97.8 %** of rendered DOM segments after the app's whole Nuxt
bundle (1,388 chunks) was downloaded and its official Hungarian i18n catalog extracted, which
made coverage measurable for the first time. 276 dead keys removed and 697 real ones added:
8,197 → 8,618.

Two things about the measurement turned out to matter more than the number:

- The bundle ships **two** catalogs. 1,835 values were Billingo's own *English* locale being
  captured as if they were Hungarian source strings; they are never rendered while the app runs
  in Hungarian, so they must be excluded, not translated.
- A key containing HTML markup is rendered through `v-html`, so the browser parses it and it
  never appears verbatim in a text node. Counting such keys as covered — or as missing —
  measures the wrong thing. The honest corpus is the text nodes the DOM actually produces.

Defects found and fixed:

- **The flood circuit-breaker never re-settled.** `obs.disconnect` had already been replaced by
  the teardown wrapper that sets `destroyed`, so the cooldown timer returned immediately and
  translation stopped permanently for the rest of the page's life after a single mutation
  storm — worst on the busiest screens.
- **A numeric pattern could rewrite any invoice total.** The key `15 000 Ft` has two digit runs
  separated by nothing but a thousands separator, so it compiled a catch-all over every
  Hungarian-formatted amount and re-joined the captures with the separator its *value* used:
  `1 234 567 Ft` rendered as `1 234,567 HUF`, off by three orders of magnitude to an English
  reader. `compileNumericPattern` now refuses a pattern whose consecutive slots are separated
  only by a group separator — a grouped amount is one number, not several.
- **Weekday abbreviations were shifted.** `Ke` (*kedd*, Tuesday) read "Wed" / "Mer" and `Hé`
  (*hétfő*, Monday) read "Hey" / "Salut", so a user picking a date "on Wednesday" clicked
  Tuesday — on a document reported to NAV. `Rét` was mapped to "Tue" and is not a weekday at
  all. All were corrected against Billingo's own `Common.form.Label:*` catalog.
- `Kft.` and `Zrt.` shared one translation, and "SARL" is wrong for a *zártkörűen működő
  részvénytársaság*; two different legal forms were indistinguishable.
- 17 values carried an `A / B` translator's gloss on a key containing no slash, which made
  sortable table headers unreadable and fed the new separator layer nonsense.
- `stats.uniqueMisses` collected our own output: Bootstrap renders `.tooltip-inner` from the
  already-translated stashed `title`, so every tooltip hover added an English or French string
  to the exported "untranslated Hungarian" list and depressed the coverage percentage.
- A blank attribute was remembered as an element's original, which made a late-bound `:title`
  untranslatable for the page's lifetime.
- `tools/build-shards.js` was destructive and crashed on a clean checkout; it also resurrected
  keys deleted from the source of truth, from its own previous output, and silently erased a
  key added to only one of the two dictionaries.
- The first ZIP writer put the central-directory offset at byte 14 instead of 16, clobbering
  the size field so every reader rejected the archive. Caught by validating the output with an
  independent unzip rather than by trusting the code.

### 2026-07-31 — layered lookup and all-zone prefetch

- Whitespace, trailing-punctuation, `:token` and numeric layers added after exact match;
  620 patterns compiled from the shipped dictionary.
- All remaining zones prefetched once the page is idle.
- `textarea` placeholders, `aria-placeholder`, `aria-description` and `label` translated.
- Dictionary integrity tests: shard/index consistency, EN↔FR key parity, key hygiene.
- Fixed: `/n/organization` pointed at a shard that does not exist, 404ing on every visit;
  inherited `Object.prototype` names (`constructor`, `toString`) could be returned as
  translations; a key shipped with a trailing space could never match, since lookup trims.

### 2026-05-25 — first working extension

- Live EN/FR translation of the Billingo UI, popup language switching with restore-to-Hungarian.
- Route-aware sharded dictionary, SPA navigation handling, `MutationObserver` for dynamic
  content.
- Anti-crash safeguards on the DOM walker: per-node re-translation cap, time slicing, flood
  circuit-breaker.
- Curated dictionaries with rationale recorded in [`TRANSLATIONS.md`](TRANSLATIONS.md).
- Original logo, README, LICENSE, PRIVACY.

[1.0.0]: https://github.com/alexvlrt/billingo-translator/releases/tag/v1.0.0
