// src/popup.js
// Popup UI controller. Reads/writes browser storage (Firefox/Zen and Chrome via
// the `browser ?? chrome` shim), sends a setLang message to the active Billingo
// tab on language change, queries the content script for live coverage stats.
// The lang picker is a WAI-ARIA radiogroup driven by .bt-lang card-buttons.
//
// It also surfaces the strings the content script could not translate and lets
// the user copy or download them. That list is the project's only feedback loop
// from real usage back into dict/{en,fr}.json, so it must never be silently
// dropped: every copy/download outcome is reported in the popup.

(function () {
  const api = globalThis.browser ?? globalThis.chrome;

  const REFRESH_MS = 2000;      // live coverage poll while the popup is open
  const FEEDBACK_MS = 3500;     // how long a copy/download result stays on screen
  const REVOKE_DELAY_MS = 5000; // let the browser start the blob download first
  const MAX_SLUG_LEN = 40;      // keep generated filenames short and predictable

  const byId = (id) => document.getElementById(id);
  const langButtons = [...document.querySelectorAll('.bt-lang')];
  const pctEl = byId('bt-coverage-pct');
  const missCountEl = byId('bt-miss-count');
  const subEl = byId('bt-coverage-sub');
  const barEl = byId('bt-bar-fill');
  const copyBtn = byId('bt-copy');
  const downloadBtn = byId('bt-download');
  const hintEl = byId('bt-export-hint');
  const truncatedEl = byId('bt-export-truncated');
  const statusEl = byId('bt-export-status');

  // Sub-line for every state in which there is no coverage figure to show.
  const INACTIVE_SUB = {
    'no-tab': 'Open a Billingo tab to translate.',
    reload: 'Reload the Billingo tab to apply.',
    hu: 'Translation off (Hungarian).',
  };

  // Why the export buttons are disabled. The `ok` entry is the case where the
  // state is fine and the miss list is simply empty — the happy ending.
  const EXPORT_HINTS = {
    'no-tab': 'Nothing to export — no Billingo tab here.',
    reload: 'Nothing to export — reload the tab first.',
    hu: 'Nothing to export — translation is off.',
    ok: 'Nothing untranslated on this page yet.',
  };

  // Last rendered view. Replaced wholesale on every refresh (never mutated) so
  // an export can never mix two polls' worth of data.
  let view = makeView('no-tab');
  let feedbackTimer = null;

  // A view is the single source of truth for both the coverage block and the
  // export block, which keeps the two from disagreeing.
  function makeView(state, extra) {
    return {
      state,
      pct: 0,
      hits: 0,
      total: 0,
      misses: [],
      missTotal: 0,
      lang: null,
      pathname: null,
      version: null,
      truncated: false,
      ...extra,
    };
  }

  // Reflect the active language on the cards (aria-checked) and the roving
  // tabindex used by the radiogroup keyboard nav.
  function setActiveLang(lang) {
    for (const btn of langButtons) {
      const active = btn.dataset.lang === lang;
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
      btn.tabIndex = active ? 0 : -1;
    }
  }

  function render(next) {
    view = next;
    renderCoverage(next);
    renderExport(next);
  }

  function renderCoverage(v) {
    if (v.state !== 'ok') {
      pctEl.textContent = '—';
      subEl.textContent = INACTIVE_SUB[v.state] ?? INACTIVE_SUB['no-tab'];
      barEl.style.width = '0%';
      setText(missCountEl, '');
      missCountEl.hidden = true;
      return;
    }
    pctEl.textContent = `${v.pct} %`;
    subEl.textContent = `${v.hits} / ${v.total} strings`;
    barEl.style.width = `${v.pct}%`;
    // The headline count is the number the tab really saw, which can exceed the
    // exportable list when the content script capped it.
    const n = v.missTotal;
    // Say how many are plausibly ours. Most of a marketplace or transaction screen's
    // misses are third-party brand names, so a bare total reads as far worse coverage
    // than the extension actually delivers.
    const likely = countLikelyHungarian(v.misses);
    const label = likely === n ? `${n} untranslated` : `${likely} of ${n} untranslated`;
    setText(missCountEl, n === 0 ? '' : label); // separator is CSS
    missCountEl.hidden = n === 0;
  }

  function renderExport(v) {
    const canExport = v.state === 'ok' && v.misses.length > 0;
    copyBtn.disabled = !canExport;
    downloadBtn.disabled = !canExport;
    const hint = canExport ? '' : (EXPORT_HINTS[v.state] ?? EXPORT_HINTS['no-tab']);
    setText(hintEl, hint);
    hintEl.hidden = hint === '';
    const truncated = canExport && v.truncated;
    if (truncated) setText(truncatedEl, truncationNote(v));
    truncatedEl.hidden = !truncated;
  }

  // Say how much was left out when the numbers allow it; an older content script
  // sends no count, and then only the generic wording is defensible.
  function truncationNote(v) {
    if (v.missTotal > v.misses.length) {
      return `List truncated — only ${v.misses.length} of ${v.missTotal} strings can be exported.`;
    }
    return 'List truncated — some untranslated strings were left out.';
  }

  // No-op-by-equality: renderExport runs on every 2 s poll, and rewriting an
  // unchanged string still fires a DOM mutation that assistive tech may replay.
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  // --- Stats plumbing -------------------------------------------------------

  // The content script is the other half of the extension and may be an older
  // build (a tab loaded before an update). Treat every field as untrusted:
  // pathname/version/truncated are optional and must not break the popup.
  function toView(stats) {
    const hits = Number.isFinite(stats.hits) ? stats.hits : 0;
    const misses = Number.isFinite(stats.misses) ? stats.misses : 0;
    const total = hits + misses;
    const unique = readMisses(stats.uniqueMisses);
    return makeView('ok', {
      pct: total === 0 ? 0 : Math.round((hits / total) * 100),
      hits,
      total,
      misses: unique,
      missTotal: readMissTotal(stats.uniqueMissCount, unique.length),
      lang: typeof stats.lang === 'string' ? stats.lang : null,
      pathname: typeof stats.pathname === 'string' ? stats.pathname : null,
      version: typeof stats.version === 'string' ? stats.version : null,
      truncated: stats.truncated === true,
    });
  }

  const HU_DIACRITIC = /[őűáéíóöúüŐŰÁÉÍÓÖÚÜ]/;

  // A Hungarian diacritic is the one cheap signal that a miss is ours rather than a
  // third-party brand: a marketplace page exported 122 strings of which 115 were
  // Shopify, Revolut, OTP Bank and the like, and only 7 carried a diacritic.
  //
  // It orders, it does NOT filter. Dropping the accent-less strings would have cut that
  // page by 94 %, but `Alkalmaz` and `Szo` carry no diacritic and both became dictionary
  // entries the day this was written. Capture already cannot see accent-less Hungarian,
  // so this export is the only place it can ever surface: hiding it here would close that
  // gap nowhere. Read the list until it turns into brand names, then stop.
  function likelyHungarianFirst(a, b) {
    const rank = (s) => (HU_DIACRITIC.test(s) ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b, 'hu');
  }

  // Deduped (an older content script may not) and sorted, so two exports of the
  // same screen diff cleanly when the strings are harvested into the dictionary.
  function readMisses(raw) {
    if (!Array.isArray(raw)) return [];
    const strings = raw.filter((s) => typeof s === 'string' && s !== '');
    return [...new Set(strings)].sort(likelyHungarianFirst);
  }

  function countLikelyHungarian(strings) {
    return strings.reduce((n, s) => n + (HU_DIACRITIC.test(s) ? 1 : 0), 0);
  }

  // Distinct misses the tab actually saw. The content script caps the list it
  // sends and reports the pre-cap total separately; without that field (older
  // build) the listed length is the best we can honestly claim. A total smaller
  // than what we received is nonsense, so it is ignored.
  function readMissTotal(reported, listed) {
    return Number.isFinite(reported) && reported >= listed ? reported : listed;
  }

  async function getActiveBillingoTab() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith('https://app.billingo.hu/')) return null;
    return tab;
  }

  async function refreshCoverage() {
    const tab = await getActiveBillingoTab();
    if (!tab) { render(makeView('no-tab')); return; }
    try {
      const stats = await api.tabs.sendMessage(tab.id, { type: 'getStats' });
      if (!stats || !stats.ok) { render(makeView('reload')); return; }
      if (stats.lang === 'hu') { render(makeView('hu')); return; }
      render(toView(stats));
    } catch {
      render(makeView('reload'));
    }
  }

  async function selectLang(lang) {
    setActiveLang(lang);
    await api.storage.sync.set({ lang });
    const tab = await getActiveBillingoTab();
    if (!tab) { render(makeView('no-tab')); return; }
    try {
      await api.tabs.sendMessage(tab.id, { type: 'setLang', lang });
    } catch {
      render(makeView('reload'));
      return;
    }
    refreshCoverage();
  }

  // --- Export ---------------------------------------------------------------

  // Preferred version is the one the content script reported (that is the build
  // that produced the misses); the popup's own manifest is the fallback.
  function manifestVersion() {
    try {
      return api.runtime.getManifest().version ?? null;
    } catch {
      return null;
    }
  }

  // `/invoices/list` → `invoices-list`. Trimming happens after the slice so a
  // truncated slug cannot end on a separator. Also keeps anything exotic in the
  // reported pathname out of the filename.
  function slugify(pathname) {
    const slug = String(pathname).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return slug.slice(0, MAX_SLUG_LEN).replace(/^-+|-+$/g, '');
  }

  // Same idea as slugify but dots survive, so a version like `1.2.3` stays readable.
  function versionTag(version) {
    return String(version ?? '').toLowerCase().replace(/[^a-z0-9.]+/g, '').slice(0, MAX_SLUG_LEN);
  }

  function exportFilename(v) {
    const parts = ['billingo-untranslated'];
    const tag = versionTag(v.version ?? manifestVersion());
    if (tag) parts.push(`v${tag}`);
    const slug = v.pathname ? slugify(v.pathname) : '';
    if (slug) parts.push(slug);
    parts.push(new Date().toISOString().slice(0, 10));
    return `${parts.join('-')}.json`;
  }

  function exportPayload(v) {
    return {
      generatedAt: new Date().toISOString(),
      extensionVersion: v.version ?? manifestVersion(),
      lang: v.lang,
      pathname: v.pathname,
      truncated: v.truncated,
      count: v.misses.length, // strings in this file
      distinctSeen: v.missTotal, // distinct misses the tab saw, before any cap
      // How many of `strings` carry a Hungarian diacritic. They come first, so this is
      // also the index where the list stops being worth reading: past it are brand names,
      // bank transaction labels and accent-less strings that may or may not be ours.
      likelyHungarian: countLikelyHungarian(v.misses),
      strings: v.misses,
    };
  }

  // Clipboard access can be denied (permissions policy, focus loss, older
  // engines), so fall back to the execCommand+textarea trick before giving up.
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Denied or unavailable — the legacy path below still works in a popup.
    }
    return copyViaTextarea(text);
  }

  function copyViaTextarea(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.setAttribute('aria-hidden', 'true');
    ta.tabIndex = -1;
    // Off-screen but still selectable: display:none or hidden would make the
    // selection (and therefore the copy) fail.
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    try {
      ta.select();
      ta.setSelectionRange(0, text.length);
      return document.execCommand('copy') === true;
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }

  // Blob + <a download>: no `downloads` permission, no network request.
  function saveJson(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      a.remove();
      // Revoking synchronously can cancel the download that just started.
      setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
    }
  }

  function showFeedback(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle('bt-err', isError === true);
    if (feedbackTimer !== null) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      statusEl.textContent = '';
      statusEl.classList.remove('bt-err');
      feedbackTimer = null;
    }, FEEDBACK_MS);
  }

  // One string per line, so internal whitespace has to go: the walker records
  // misses trimmed, but Billingo's markup leaves inner line breaks and
  // indentation inside a text node (that is why the translator has a whitespace
  // layer at all). Collapsing can merge two variants, hence the second dedupe.
  // The JSON export keeps the raw strings — there, exactness matters more.
  function toClipboardLines(misses) {
    return [...new Set(misses.map((s) => s.replace(/\s+/g, ' ')))];
  }

  async function onCopy() {
    const lines = toClipboardLines(view.misses); // snapshot: a poll may replace `view` mid-await
    if (lines.length === 0) { showFeedback('Nothing to copy.', true); return; }
    const ok = await copyToClipboard(lines.join('\n'));
    showFeedback(
      ok
        ? `Copied ${lines.length} strings.`
        : 'Copy was blocked by the browser — use Download.',
      !ok,
    );
    // The clipboard fallback moves the selection around; hand focus back so
    // keyboard users stay on the button they activated.
    if (!copyBtn.disabled) copyBtn.focus();
  }

  function onDownload() {
    const snapshot = view;
    if (snapshot.misses.length === 0) { showFeedback('Nothing to download.', true); return; }
    try {
      saveJson(exportFilename(snapshot), JSON.stringify(exportPayload(snapshot), null, 2));
      showFeedback(`Saved ${snapshot.misses.length} strings as JSON.`, false);
    } catch (err) {
      showFeedback(`Download failed: ${err && err.message ? err.message : 'unknown error'}`, true);
    }
  }

  // --- Wiring ---------------------------------------------------------------

  for (const btn of langButtons) {
    btn.addEventListener('click', () => selectLang(btn.dataset.lang));
    btn.addEventListener('keydown', (e) => {
      const i = langButtons.indexOf(btn);
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        const next = langButtons[(i + 1) % langButtons.length];
        next.focus(); selectLang(next.dataset.lang);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const prev = langButtons[(i - 1 + langButtons.length) % langButtons.length];
        prev.focus(); selectLang(prev.dataset.lang);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        selectLang(btn.dataset.lang);
      }
    });
  }

  // Native <button> elements: Enter/Space already fire click, so no key handler.
  copyBtn.addEventListener('click', () => {
    onCopy().catch((err) => showFeedback(`Copy failed: ${err.message}`, true));
  });
  downloadBtn.addEventListener('click', onDownload);

  // Initial paint.
  (async () => {
    // Footer version straight from the manifest, so it can never disagree with the
    // build that is actually installed.
    const versionEl = document.getElementById('bt-version');
    if (versionEl) {
      const v = manifestVersion();
      versionEl.textContent = v ? `v${v} · ` : '';
    }
    const { lang = 'hu' } = await api.storage.sync.get({ lang: 'hu' });
    setActiveLang(lang);
    refreshCoverage();
  })();

  // Refresh coverage every 2 s while the popup is open.
  setInterval(refreshCoverage, REFRESH_MS);
})();
