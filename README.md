<div align="center">

<img src="icons/icon128.png" width="96" height="96" alt="Translator for Billingo logo">

# Translator for Billingo

**Read the Hungarian [Billingo](https://app.billingo.hu) invoicing UI in English or French — live, in place, no reload.**

[![License: MIT](https://img.shields.io/badge/License-MIT-4F46E5.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-4F46E5.svg)](CHANGELOG.md)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4F46E5.svg)](manifest.json)
[![Coverage 97.8%](https://img.shields.io/badge/coverage-97.8%25-4F46E5.svg)](CHANGELOG.md)
[![Chrome + Firefox](https://img.shields.io/badge/Chrome%20%2B%20Firefox-supported-4F46E5.svg)](#-install)

[Install](#-install) · [Usage](#-usage) · [Development](#-development) · [Privacy](#-privacy) · [Changelog](CHANGELOG.md)

</div>

> [!IMPORTANT]
> **Unofficial extension.** An independent, community-built tool — **not affiliated with, endorsed by, or connected to Billingo** or its operators. "Billingo" is a trademark of its respective owner, used here only to describe what the extension does.

---

## 💡 Why

Billingo is a good Hungarian invoicing tool, but its interface is **Hungarian only**. If you are a
non-Hungarian-speaking founder, accountant or freelancer who has to use it, every screen is a
guessing game. This extension overlays a **hand-curated English or French translation** on the live
UI so you can read what you are clicking.

Coverage is measured, not claimed: **97.8 %** of the text Billingo actually renders, checked against
the app's own Hungarian message catalog. [`CHANGELOG.md`](CHANGELOG.md) explains how that number is
obtained and what the remaining 2 % is.

## ✨ Features

|  | |
| --- | --- |
| 🌍 **Live translation** | `app.billingo.hu` in **English** or **French**, substituted in place. |
| ⚡ **Instant switching** | No reload. The original Hungarian is remembered per node, so **Magyar (off)** restores the page exactly. |
| 🧩 **Route-aware dictionary** | Sharded per app section: the current page's shard loads first, the rest arrive once the page is idle, so modals and banners from other sections are covered too. |
| 🔁 **SPA-aware** | Follows Billingo's in-app navigation and dynamically rendered content. |
| 🧠 **Beyond exact matches** | Eight lookup layers handle indentation, trailing punctuation, casing, `:token` templates (`:type letöltése` → `Télécharger la facture`), numbers (`17 db` → `17 pièces`), parentheses and separators. |
| 🧾 **Fiscal safety** | Amounts, tax numbers, invoice serials, IBANs, dates and addresses are never rewritten — a wrong number on a NAV-reported document is worse than untranslated text, and a test enforces it against the real dictionary. |
| 📤 **Miss export** | The popup can copy or download every string it could not translate. That is how the dictionary grows. |
| 🔒 **Private by design** | No analytics, no servers, nothing leaves your browser. See [`PRIVACY.md`](PRIVACY.md). |
| 🧱 **Manifest V3** | One codebase for **Chrome / Edge** and **Firefox**. |

## 🚀 Install

Everything you need is attached to the [**latest release**](../../releases/latest). Both browsers
install for good — no developer mode, no folder to keep around, no store account.

### 🦊 Firefox / Zen

Download the **`.xpi`** and open it in Firefox. It is signed by Mozilla, so it installs like any
other add-on and stays installed.

> [!IMPORTANT]
> Needs **Firefox 127+**. Before 127 Firefox did not grant the host permission behind
> `content_scripts` at install time, so the add-on would install and translate nothing. Zen and
> other current forks are well past that floor.

### 🌐 Chrome / Edge

Chrome refuses any extension that no policy names, so this takes two files instead of one: the
signed package, and a one-off policy naming its ID. Chrome applies these policies on ordinary
consumer installs, not just managed fleets.

1. Download **`translator-for-billingo-policy.zip`**.
2. Unzip it and deploy **one** of the two folders — admin rights, once per machine:

   | | Auto-updates | You can remove it | Also download the `.crx` |
   | --- | --- | --- | --- |
   | **`forcelist/`** *(recommended)* — Chrome fetches and installs it for you | ✅ | ❌ | no |
   | `allowlist/` — only unblocks the ID, you install it yourself | ❌ | ✅ | yes, drag it onto `chrome://extensions` |

   ```bash
   # Windows, as admin — double-click, or:
   reg import forcelist\windows-chrome.reg
   # Linux
   sudo cp forcelist/linux-chrome.json /etc/opt/chrome/policies/managed/
   # macOS — install forcelist/macos-chrome.plist as a configuration profile
   ```

   Edge uses the same files with `Microsoft\Edge` in place of `Google\Chrome`.

3. Restart the browser and check **`chrome://policy`**. If the policy is not listed there, nothing
   else will work.

`README.txt` inside the zip repeats all of this, offline.

<details>
<summary>Chrome Web Store instead</summary>

The Web Store listing does not exist yet. Publishing there needs a one-off developer fee; unlisted
visibility is available, so it would not mean going public.

</details>

## 🎯 Usage

Open [Billingo](https://app.billingo.hu), click the toolbar icon, and pick **Magyar (off)**,
**English** or **Français**.

The popup also shows live coverage for the current page, and lets you copy or download the strings
it could not translate — paste that list into an issue and it becomes the next batch of
translations.

---

## 🛠️ Development

### Setup

```bash
npm install     # jsdom, acorn, playwright — needed by the tests
npm test        # 313 tests, node:test
```

No bundler, no build step for the extension itself: `dist/` is a filtered copy.

### Building locally

```bash
npm run package        # no npm install needed — the packaging step has zero dependencies
```

| Output | Use |
| --- | --- |
| `dist/chrome/`, `dist/firefox/` | unpacked, for `chrome://extensions` → **Load unpacked** and `about:debugging` |
| `dist/translator-for-billingo-chrome-1.0.0.zip` | Chrome Web Store upload |
| `dist/translator-for-billingo-firefox-1.0.0.zip` | AMO upload → Mozilla returns a signed `.xpi` |

The payload is an allowlist of exactly the files needed at runtime, and the build refuses to write
anything when it is inconsistent — a missing content script, an icon or popup asset that would 404,
a `web_accessible_resources` pattern matching no file, an ESM `import` that would stop Chrome
evaluating a content script, or a shard named by `dict/_index.json` and absent in one language.

For a loaded-from-disk Chrome build, copy `dist/chrome/` somewhere **stable** first — Chrome reads
it on every start. On Windows + WSL that means a Windows path such as
`C:\Users\<you>\billingo-translator-extension\`; a `\\wsl.localhost\…` path breaks whenever WSL is
not running.

<details>
<summary>Signing the two packages by hand</summary>

```bash
# Firefox — AMO signs it without listing it publicly ("self-distribution")
npx --yes web-ext@8 sign --source-dir dist/firefox --channel unlisted \
    --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"

# Chrome — our own key, which also produces updates.xml and the policy bundle
openssl genrsa -out crx-key.pem 2048       # keep this OUT of the repo, and back it up
npm run package:crx -- --key crx-key.pem
```

Run `npm run lint:ext` before submitting to AMO: Mozilla's own validator should report 0 errors and
0 warnings. On Developer Edition / Nightly / ESR you can skip signing altogether by setting
`xpinstall.signatures.required` to `false` in `about:config` and loading `dist/firefox/`.

> [!WARNING]
> The Chrome extension ID is derived from the signing key. Losing it or rotating it produces a
> *different* extension: every installed copy stops updating, and the old ID can never be
> re-issued.

</details>

### Releasing

Pushing a `v*` tag is the whole release process.

```bash
# bump the version in BOTH manifest.json and package.json, then:
git tag v1.0.1 && git push origin v1.0.1
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) tests, builds, lints, signs the
Firefox add-on through AMO, packs the Chrome `.crx` with its policies, optionally publishes to the
Web Store, and attaches everything to the GitHub Release. `workflow_dispatch` runs a **dry run** by
default — signing burns an AMO version number, and a burnt version cannot be reused.

| Secret | For | Required |
| --- | --- | --- |
| `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` | Firefox signing — [get them here](https://addons.mozilla.org/developers/addon/api/key/) | ✅ |
| `CRX_PRIVATE_KEY` | the Chrome `.crx`, `updates.xml` and the policy bundle (PEM contents) | ❌ — the step skips itself when absent |
| `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`, `CHROME_EXTENSION_ID`, `CHROME_PUBLISHER_ID` | Chrome Web Store publish | ❌ — the step skips itself when absent |

> [!IMPORTANT]
> A tag push runs the workflow **from the tagged commit**, not from `main`. Tagging a commit older
> than `release.yml` fires nothing at all — no run, no failure, no notification.

Two identity fields make updates work rather than installing a second copy of the extension:
`browser_specific_settings.gecko.id` on Firefox, and the CRX signing key on Chrome. Neither may
change between versions. Chrome has no signing step for the Web Store — it signs on publish, and
its API can only *update* an existing item, so that listing has to be created by hand first.

### Repository layout

Two halves with **different rules** — conflating them is the easiest mistake to make here:

| | Path | Modules | Ships |
| --- | --- | --- | --- |
| **Runtime extension** | `src/`, `dict/`, `manifest.json`, `icons/` | classical scripts (**no ESM**) | ✅ |
| **Build & capture tooling** | `tools/`, `scripts/` | ESM (`"type": "module"`) | ❌ |

> [!WARNING]
> **Never add `import`/`export` to `src/`.** Those files are loaded by the browser as classical
> content scripts, in the fixed order set by `manifest.json`, each an IIFE publishing onto
> `globalThis.BillingoTranslator`. An ESM statement makes Chrome refuse to evaluate the script, and
> the failure only shows up on the live site. `npm run package` fails the build if it finds one.

| File | Responsibility |
| --- | --- |
| `src/translator.js` | Pure lookup, eight layers, plus hit/miss stats. No DOM, no `chrome.*`. |
| `src/dom-walker.js` | Walks text nodes and translatable attributes, remembers originals, runs the `MutationObserver`. |
| `src/shard-loader.js` | Route → zone → lazy `fetch` of `dict/<lang>/<zone>.json`, merged into one object. |
| `src/spa-router.js` | Detects Billingo's SPA navigation (polling is the reliable path). |
| `src/content.js` | Wiring, storage, popup messaging, monolithic-dict fallback. |
| `src/popup.{html,js,css}` | Language picker, live coverage, miss export. |

### Commands

```bash
npm test                            # the whole suite (313 tests)
npm run package                     # dist/{chrome,firefox} + one zip each, validated
npm run package:crx -- --key <pem>  # signed .crx + updates.xml + policy bundle
npm run lint:ext                    # Mozilla web-ext lint over dist/firefox (via npx)

node tools/build-shards.js          # dict/{en,fr}.json -> dict/<lang>/<zone>.json
node tools/mine-html-keys.js        # derive matchable segments from v-html keys
node scripts/build-icons.mjs        # PNGs from icons/icon.svg; needs `npm i sharp` ad hoc
```

### Adding translations

`dict/en.json` and `dict/fr.json` are the **source of truth**. The per-zone files in `dict/en/` and
`dict/fr/` are **generated** — editing them directly is overwritten by the next build.

1. Add `"<hungarian>": "<translation>"` to **both** `dict/en.json` and `dict/fr.json`. The key sets
   must stay identical, and **no value may be empty**: an empty value means "miss" and leaves
   Hungarian on screen.
2. Run `node tools/build-shards.js`.
3. Record any non-obvious fiscal or legal choice in [`TRANSLATIONS.md`](TRANSLATIONS.md) as a dated
   entry.
4. `npm test`, then open a pull request.

The fastest way to find what is missing: use the extension, then hit **Copy untranslated** in the
popup. That list is exactly what the dictionary lacks on the screens you actually visit.

`dict/_rejected.json` is a committed denylist of strings that must never become keys (foreign date
locales, dev doc comments, internal fixtures). Adding an entry is a documented decision; without
it, the next capture resurrects the same garbage.

### Where the strings come from

`tools/` can rebuild the candidate list from the app itself. `tools/extract-bundle.js` needs a
Netscape cookie jar for an authenticated session — only to fetch the app shell, since the Nuxt
chunks themselves are public. It yields Billingo's own Hungarian message catalog, the authoritative
inventory of everything the UI can display.

> [!CAUTION]
> `app.billingo.hu` is a **production invoicing app wired to NAV**, the Hungarian tax authority —
> not a sandbox. Capture tooling must stay strictly **read-only**: navigate by URL, open dropdowns,
> then Escape. Never click a commit control — no document issue, no draft save, no wizard "Tovább"
> (it can start a real bank link), no delete or confirm.

### Testing

`node:test` + `assert`. Pure logic is tested directly, DOM code under jsdom, and `src/*.js` is
loaded through `vm` (`tests/load-script.js`) because those files have no exports. There is no lint,
type-check or CI — the tests are the only automated safety net, so **add one for any change** to the
walker, the translator layers, the loader, the router, the filters or the packaging.

Two tests guard whole classes of defect rather than individual functions:

- **`tests/dict-fiscal-safety.test.js`** runs the **real** dictionary through the real translator.
  Every other translator test uses a synthetic one, which is exactly how an amount-mangling bug once
  slipped through.
- **`tests/package.test.js`** asserts the ZIP structure a real unzip expects, and the per-browser
  manifest rules.

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and every pull
request: install, test, package, and Mozilla's `web-ext lint`. Packages are attached as build
artifacts, so a reviewer can load a branch without building it locally.

Two deliberate choices worth knowing before you touch them:

- `npm ci --ignore-scripts` — playwright's postinstall downloads ~400 MB of browsers that only
  `tools/` uses, never the tests.
- `npm test` globs `tests/*.test.js`, **one level**. `tests/**/*.test.js` is expanded by neither
  POSIX `sh` nor bash without `globstar`, so it reached `node` as a literal string and depended on
  the test runner's own glob support — which varies by Node version and would have broken CI on a
  different runner image.

Architecture detail and the invariants you must not break live in [`CLAUDE.md`](CLAUDE.md).

---

## 🔒 Privacy

No personal data collected, no external network requests. Your language preference is stored in your
browser's sync storage. Full details in [`PRIVACY.md`](PRIVACY.md).

## ⚖️ Disclaimer & License

This project is an **independent, unofficial** tool and is **not affiliated with, sponsored by, or
endorsed by Billingo** or its operating company. All product names, logos and trademarks are the
property of their respective owners. Provided "as is", with no warranty — use at your own
discretion.

[MIT](LICENSE) © 2026 Alexandre Vuillerot
