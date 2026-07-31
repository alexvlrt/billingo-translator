# Changelog

All notable changes to **Translator for Billingo** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-07-31

Coverage release: the same dictionary now matches a lot more of what Billingo
actually renders.

### Added
- Layered lookup in the translator, applied after an exact-match miss:
  - **whitespace normalisation** — indented, wrapped and NBSP-separated text now matches;
  - **trailing punctuation** — a label shipped as `Adószám` also matches `Adószám:` and `Megjegyzés *`, keeping the punctuation in the output;
  - **`:token` templates** — `:type letöltése` fills from the rendered text and translates the captured fragment (`Számla letöltése` → `Télécharger la facture`);
  - **numeric templates** — `3 db` generalises to any number (`17 db` → `17 pièces`), preferring the plural source pair.
  620 patterns compile from the shipped dictionary.
- All remaining dictionary zones are prefetched once the page is idle, so text
  coming from another section (partner modal in the invoice editor, upsell
  banners) is translated too. First paint is unaffected.
- `textarea` placeholders, `aria-placeholder`, `aria-description` and `label`
  are now translated. `textarea` **content** is still left untouched — it is user data.
- Dictionary integrity tests: shard/index consistency, EN↔FR key parity, key hygiene.

### Fixed
- `/n/organization` pointed at a shard that does not exist, 404ing on every visit
  to those routes; the index now only lists zones that were actually built.
- Inherited `Object.prototype` names (`constructor`, `toString`) could be returned
  as translations.
- A dictionary key shipped with a trailing space could never match, since lookup trims.

## [1.0.0] — 2026-05-25

First public release.

### Added
- Live translation of the Billingo (`app.billingo.hu`) UI into **English** and **French**.
- Instant language switching from the popup, with restore-to-Hungarian ("Magyar (off)").
- Route-aware, sharded dictionary that loads only the shard needed for the current page.
- SPA-aware navigation handling and a `MutationObserver` for dynamically rendered content.
- Anti-crash safeguards on the DOM walker (per-node re-translation cap, time-sliced processing, mutation-flood circuit-breaker).
- Curated dictionaries with documented translation choices in `TRANSLATIONS.md`.
- Cross-browser support (Chrome / Edge and Firefox, Manifest V3).
- Original logo and project documentation (README, LICENSE, PRIVACY).

[1.1.0]: https://github.com/alexvlrt/billingo-translator/releases/tag/v1.1.0
[1.0.0]: https://github.com/alexvlrt/billingo-translator/releases/tag/v1.0.0
