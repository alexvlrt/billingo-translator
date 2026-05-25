# Changelog

All notable changes to **Translator for Billingo** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/alexvlrt/billingo-translator/releases/tag/v1.0.0
