# Privacy Policy — Translator for Billingo

_Last updated: 2026-05-25_

**Translator for Billingo** ("the extension") is an independent, unofficial browser
extension that translates the Billingo (`app.billingo.hu`) user interface into English
or French. This policy explains exactly what the extension does and does not do with
data.

## Summary

- The extension **does not collect, transmit, or sell any personal data**.
- It makes **no requests to any external or third-party server**. The dictionaries are
  bundled inside the extension.
- There is **no analytics, no tracking, and no advertising**.
- Everything stays **inside your own browser**.

## What is stored, and where

| Data | Storage | Purpose | Leaves your browser? |
| --- | --- | --- | --- |
| Selected language (`hu` / `en` / `fr`) | `chrome.storage.sync` | Remember your preference across pages and devices | No — only synced by your browser to your own browser account, never to the developer |

## Permissions and why they are needed

- **`storage`** — to save your language preference and the locally collected strings
  described above.
- **Host access to `https://app.billingo.hu/*`** — required so the extension can read the
  page's Hungarian text and replace it with the translated text. The extension runs
  **only** on this domain and on no other website.

## What the extension does NOT do

- It does not read or transmit your invoices, customers, financial data, or any account
  information.
- It does not send anything to the developer or to any third party.
- It does not use cookies, fingerprinting, or any tracking technology.

## Data sharing

None. No data is shared with anyone, because no data ever leaves your browser.

## Contact

Questions or concerns? Open an issue at
<https://github.com/alexvlrt/billingo-translator/issues>.

## Changes to this policy

If this policy changes, the updated version will be published in this repository with a
new "Last updated" date.
