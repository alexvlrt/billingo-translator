// src/popup.js
// Popup UI controller. Reads/writes browser storage (Firefox/Zen and Chrome via
// the `browser ?? chrome` shim), sends a setLang message to the active Billingo
// tab on language change, queries the content script for live coverage stats.
// The lang picker is a WAI-ARIA radiogroup driven by .bt-lang card-buttons.

(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const langButtons = [...document.querySelectorAll('.bt-lang')];
  const pctEl = document.getElementById('bt-coverage-pct');
  const subEl = document.getElementById('bt-coverage-sub');
  const barEl = document.getElementById('bt-bar-fill');

  // Reflect the active language on the cards (aria-checked) and the roving
  // tabindex used by the radiogroup keyboard nav.
  function setActiveLang(lang) {
    for (const btn of langButtons) {
      const active = btn.dataset.lang === lang;
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
      btn.tabIndex = active ? 0 : -1;
    }
  }

  function renderCoverage(s) {
    if (s.state === 'no-tab') {
      pctEl.textContent = '—';
      subEl.textContent = 'Open a Billingo tab to translate.';
      barEl.style.width = '0%';
      return;
    }
    if (s.state === 'reload') {
      pctEl.textContent = '—';
      subEl.textContent = 'Reload the Billingo tab to apply.';
      barEl.style.width = '0%';
      return;
    }
    if (s.state === 'hu') {
      pctEl.textContent = '—';
      subEl.textContent = 'Translation off (Hungarian).';
      barEl.style.width = '0%';
      return;
    }
    pctEl.textContent = `${s.pct} %`;
    subEl.textContent = `${s.hits} / ${s.total} strings`;
    barEl.style.width = `${s.pct}%`;
  }

  async function getActiveBillingoTab() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith('https://app.billingo.hu/')) return null;
    return tab;
  }

  async function refreshCoverage() {
    const tab = await getActiveBillingoTab();
    if (!tab) { renderCoverage({ state: 'no-tab' }); return; }
    try {
      const stats = await api.tabs.sendMessage(tab.id, { type: 'getStats' });
      if (!stats || !stats.ok) { renderCoverage({ state: 'reload' }); return; }
      if (stats.lang === 'hu') { renderCoverage({ state: 'hu' }); return; }
      const total = stats.hits + stats.misses;
      const pct = total === 0 ? 0 : Math.round((stats.hits / total) * 100);
      renderCoverage({ state: 'ok', pct, hits: stats.hits, total });
    } catch {
      renderCoverage({ state: 'reload' });
    }
  }

  async function selectLang(lang) {
    setActiveLang(lang);
    await api.storage.sync.set({ lang });
    const tab = await getActiveBillingoTab();
    if (!tab) { renderCoverage({ state: 'no-tab' }); return; }
    try {
      await api.tabs.sendMessage(tab.id, { type: 'setLang', lang });
    } catch {
      renderCoverage({ state: 'reload' });
      return;
    }
    refreshCoverage();
  }

  // Click + keyboard wiring.
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

  // Initial paint.
  (async () => {
    const { lang = 'hu' } = await api.storage.sync.get({ lang: 'hu' });
    setActiveLang(lang);
    refreshCoverage();
  })();

  // Refresh coverage every 2 s while the popup is open.
  setInterval(refreshCoverage, 2000);
})();
