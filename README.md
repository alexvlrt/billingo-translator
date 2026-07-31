<div align="center">

<img src="icons/icon128.png" width="96" height="96" alt="Translator for Billingo logo">

# Translator for Billingo

**Translate the Hungarian [Billingo](https://app.billingo.hu) invoicing UI into English or French — live, in place, no reload.**

[![License: MIT](https://img.shields.io/badge/License-MIT-4F46E5.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.1.0-4F46E5.svg)](CHANGELOG.md)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4F46E5.svg)](manifest.json)
[![Chrome + Firefox](https://img.shields.io/badge/Chrome%20%2B%20Firefox-supported-4F46E5.svg)](#install)

</div>

> [!IMPORTANT]
> **Unofficial extension.** This is an independent, community-built tool. It is **not affiliated with, endorsed by, or connected to Billingo** or its operators. "Billingo" is a trademark of its respective owner and is used here only to describe what the extension does.

---

## Why

Billingo is a great Hungarian invoicing tool — but its interface is **Hungarian only**. If you're a non-Hungarian-speaking founder, accountant, or freelancer who has to use it, every screen is a guessing game. This extension overlays a **hand-curated English or French translation** on top of the live UI so you can actually read what you're clicking.

## Features

- 🌍 **Live translation** of `app.billingo.hu` into **English** or **French**.
- ⚡ **Instant switching** — change language from the popup, no page reload. Original Hungarian text is remembered, so you can switch back to **Magyar (off)** at any time.
- 🧩 **Route-aware dictionary** — the dictionary is sharded per app section; the shard for the current page loads first, then the rest are pulled in once the page is idle so modals and banners from other sections are covered too.
- 🔁 **SPA-aware** — follows Billingo's in-app navigation and dynamically rendered content (via a `MutationObserver`).
- 🧠 **Beyond exact matches** — normalises whitespace, tolerates trailing label punctuation, and fills templated messages (`:type letöltése` → `Télécharger la facture`, `17 db` → `17 pièces`), so dynamic text is translated too.
- ✍️ **Curated, documented translations** — non-obvious fiscal/legal terms are translated deliberately, with rationale recorded in [`TRANSLATIONS.md`](TRANSLATIONS.md).
- 🔒 **Private by design** — no analytics, no servers, no data leaves your browser. See [`PRIVACY.md`](PRIVACY.md).
- 🧱 **Manifest V3**, works on **Chrome / Edge** and **Firefox**.

## Screenshots

> 📸 _Screenshots are added with the first store release. See [`store/`](store/) for the listing assets._

## Install

### From the stores (recommended)

| Browser | Link |
| --- | --- |
| Chrome / Edge | _Chrome Web Store — coming soon_ |
| Firefox | _Firefox Add-ons (AMO) — coming soon_ |

### From source (developer mode)

**Chrome / Edge**

1. Clone or [download](https://github.com/alexvlrt/billingo-translator) this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder.
5. Pin **Translator for Billingo** in the toolbar.

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json`.
   _(Temporary add-ons are removed on restart — for permanent local use, install the signed `.xpi` once published.)_

Then open [Billingo](https://app.billingo.hu), click the toolbar icon, and pick your language.

## Usage

- Click the toolbar icon → choose **Magyar (off)**, **English**, or **Français**.
- The popup shows live **coverage** for the current page.

## How it works

The extension is a content script that runs only on `https://app.billingo.hu/*`. It never talks to a remote server — the dictionary ships inside the extension.

| Component | Responsibility |
| --- | --- |
| `src/translator.js` | Pure lookup: Hungarian string → EN/FR string. |
| `src/dom-walker.js` | Walks text nodes, translates them, and remembers the original so it can restore Hungarian. |
| `src/shard-loader.js` | Loads the right dictionary shard for the current route (`dict/_index.json` maps route prefixes → shards). |
| `src/spa-router.js` | Detects Billingo's single-page-app navigation and re-runs translation. |
| `src/content.js` | Wires it together, observes DOM mutations, and talks to the popup. |
| `dict/<lang>/<shard>.json` | The curated dictionaries (`en/`, `fr/`). |

## Contributing translations

Coverage grows by adding string pairs.

1. Add the pair to **`dict/en.json`** and **`dict/fr.json`** — these are the source of truth. The per-zone files in `dict/en/` and `dict/fr/` are **generated**, so editing them directly is overwritten by the next build.
2. Re-shard with `node tools/build-shards.js`.
3. For any non-obvious choice (fiscal, legal, or ambiguous terms), add a short note to [`TRANSLATIONS.md`](TRANSLATIONS.md).
4. Run the tests and open a pull request.

Translation discussions and corrections are very welcome — [open an issue](https://github.com/alexvlrt/billingo-translator/issues).

## Development

```bash
npm install      # dev dependencies (jsdom, playwright)
npm test         # run the test suite
```

**Rebuilding the icon.** The toolbar icon is generated from [`icons/icon.svg`](icons/icon.svg) (the `Á` glyph is traced to a path, so the SVG is font-independent). To regenerate the PNGs after editing the SVG:

```bash
npm i sharp      # not a project dependency; install ad hoc
node scripts/build-icons.mjs
```

## Privacy

This extension collects **no personal data** and makes **no external network requests**. Your language preference is stored in your browser's sync storage. Full details in [`PRIVACY.md`](PRIVACY.md).

## Disclaimer

This project is an **independent, unofficial** tool and is **not affiliated with, sponsored by, or endorsed by Billingo** or its operating company. All product names, logos, and trademarks are the property of their respective owners. It is provided "as is" under the MIT license, with no warranty — use at your own discretion.

## License

[MIT](LICENSE) © 2026 Alexandre Vuillerot
