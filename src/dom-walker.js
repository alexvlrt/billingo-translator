// src/dom-walker.js
// Walks a DOM subtree, substitutes matching text nodes and translatable
// attributes. Plain (non-module) script — no ESM exports.
//
// Live language switching: original HU text is stashed per-node in WeakMaps
// so re-walking with a different translator restores or re-translates without
// a page reload.
//
// Performance: the MutationObserver tracks our own writes (via the
// `ourWrites` WeakMap) and skips them so we don't loop on the
// characterData mutations our own translations cause. Observer callbacks
// are batched into an idle callback to avoid blocking the main thread on
// busy SPAs.

(function () {
  const TRANSLATABLE_ATTRS = [
    'placeholder', 'title', 'aria-label', 'alt',
    'aria-placeholder', 'aria-description', 'label',
  ];
  // `data-original-title` is deliberately NOT in that list, and not observed
  // either. It is Bootstrap 4's tooltip stash: `_fixTitle()` moves `title` into it
  // and blanks `title`, `_restoreTitle()` copies it back and drops it. Writing the
  // stash breaks the "originals live in WeakMaps" invariant, because the value
  // `_restoreTitle()` puts back into `title` is then OUR translation: the element's
  // remembered Hungarian is replaced by our own output, the tooltip freezes in one
  // language, and the translation is exported as untranslated Hungarian.
  // Leaving the stash alone costs almost nothing: in the common order (our walk
  // first) Bootstrap stashes the already-translated `title`, so the tooltip shows
  // the translation anyway. The one case we give up is a tooltip Bootstrap
  // initialised BEFORE our first walk (Hungarian in the stash, `title=""`): its
  // first pop-up flashes Hungarian until the rendered `.tooltip-inner` text node is
  // caught by the observer an idle flush later, and `_restoreTitle()` then hands the
  // Hungarian back through `title`, where we do translate it — so every later
  // pop-up is translated. A sub-frame flash on one hover is not worth an invariant.
  // (The Bootstrap 5 spellings `data-bs-original-title` / `data-bs-title` occur
  // nowhere in the bundle — Billingo ships Bootstrap 4.6.2 — so they are moot.)
  // A TEXTAREA's content is user data (invoice comments) and must never be
  // touched, but its placeholder is UI chrome — so it is skipped for text and
  // kept for attributes. SCRIPT/STYLE/NOSCRIPT are skipped for both.
  const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
  const SKIP_ELEMENT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
  const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'reset']);
  // On these elements every attribute we translate is a machine value rather
  // than visible text: `<link title>` names an alternate-stylesheet set,
  // `<meta>`/`<base>` render nothing, and `<html>` carries only framework
  // bookkeeping (lang, data-n-head, our own data-bt-lang test hook). They became
  // reachable when the walk moved from <body> to document.documentElement, so
  // the guard is what makes that root safe.
  const SKIP_ATTR_TAGS = new Set(['LINK', 'META', 'BASE', 'HTML']);

  const originalText = new WeakMap();   // text node → original HU value
  const originalAttrs = new WeakMap();  // element → { attr → original HU }
  const ourTextWrites = new WeakMap();  // text node → last value we wrote
  const ourAttrWrites = new WeakMap();  // element → { attr → last value we wrote }

  // --- Anti-crash state (P2) -------------------------------------------------
  const retranslate = new WeakMap();   // node -> { n, t0 } re-translations in window
  const volatileNodes = new WeakSet(); // nodes we've given up on (loop guard)
  const RETRANSLATE_CAP = 5;
  const RETRANSLATE_WINDOW_MS = 2000;
  const devCounters = { volatile: 0, circuitBreaks: 0 };

  const SLICE_SIZE = 200;
  const defaultSchedule =
    typeof requestIdleCallback !== 'undefined'
      ? (cb) => requestIdleCallback(cb, { timeout: 200 })
      : (cb) => setTimeout(cb, 0);
  let walkGen = 0;

  // Process `items` with `perItem`, `sliceSize` per synchronous burst, yielding
  // via `schedule` between bursts. If `gen` is given, abort when `walkGen` moves
  // past it (a newer FULL walk supersedes this one). Mutation processing passes
  // no `gen` — it is incremental, idempotent, and must not be cancelled by, or
  // cancel, a full walk.
  function runSliced(items, perItem, sliceSize, schedule, gen) {
    let i = 0;
    function step() {
      const end = Math.min(i + sliceSize, items.length);
      for (; i < end; i++) {
        if (gen != null && walkGen !== gen) return; // superseded by a newer full walk
        perItem(items[i]);
      }
      if (i < items.length) schedule(step);
    }
    step(); // first slice runs synchronously
  }

  // Collect translatable work items (text nodes + elements) under `root` into
  // `items`. Each walker prunes its own skip set via FILTER_REJECT, and volatile
  // text nodes are skipped.
  function collectItems(root, doc, items) {
    const textWalker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (volatileNodes.has(node)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentNode;
        if (!parent || SKIP_TEXT_TAGS.has(parent.nodeName)) return NodeFilter.FILTER_REJECT;
        const trimmed = node.nodeValue && node.nodeValue.trim();
        return trimmed ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = textWalker.nextNode())) items.push({ t: 'text', node: n });

    const elementWalker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        return SKIP_ELEMENT_TAGS.has(el.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    let el = root.nodeType === 1 && !SKIP_ELEMENT_TAGS.has(root.nodeName) ? root : elementWalker.nextNode();
    while (el) { items.push({ t: 'el', el }); el = elementWalker.nextNode(); }
  }

  function bumpRetranslate(node) {
    const now = Date.now();
    const rc = retranslate.get(node);
    const fresh = !rc || now - rc.t0 > RETRANSLATE_WINDOW_MS;
    const count = fresh ? 1 : rc.n + 1;
    retranslate.set(node, { n: count, t0: fresh ? now : rc.t0 });
    return count;
  }

  function rememberText(node, original) {
    if (!originalText.has(node)) originalText.set(node, original);
    return originalText.get(node);
  }

  function rememberAttr(el, attr, original) {
    let map = originalAttrs.get(el);
    if (!map) {
      map = Object.create(null);
      originalAttrs.set(el, map);
    }
    if (!(attr in map)) map[attr] = original;
    return map[attr];
  }

  function recordTextWrite(node, value) {
    ourTextWrites.set(node, value);
  }

  function recordAttrWrite(el, attr, value) {
    let map = ourAttrWrites.get(el);
    if (!map) {
      map = Object.create(null);
      ourAttrWrites.set(el, map);
    }
    map[attr] = value;
  }

  function isOurTextWrite(node) {
    return ourTextWrites.has(node) && ourTextWrites.get(node) === node.nodeValue;
  }

  function isOurAttrWrite(el, attr) {
    const map = ourAttrWrites.get(el);
    if (!map || !(attr in map)) return false;
    return el.getAttribute(attr) === map[attr];
  }

  function translateTextNode(node, translate, stats) {
    if (volatileNodes.has(node)) return;            // gave up on this looping node
    const original = rememberText(node, node.nodeValue);
    const trimmed = original.trim();
    if (!trimmed) return;
    const translated = translate(trimmed);
    if (translated !== null) {
      const leading = original.match(/^\s*/)[0];
      const trailing = original.match(/\s*$/)[0];
      const newVal = leading + translated + trailing;
      if (node.nodeValue !== newVal) {              // no-op-by-equality
        // Only count framework reverts toward the cap, not our own re-writes
        // (e.g. a user switching languages must not trip the loop-breaker).
        const externalRevert = ourTextWrites.get(node) !== node.nodeValue;
        if (externalRevert && bumpRetranslate(node) > RETRANSLATE_CAP) {
          volatileNodes.add(node);
          devCounters.volatile += 1;
          return;                                   // leave node as-is; break the loop
        }
        node.nodeValue = newVal;
      }
      recordTextWrite(node, newVal);
      // Pass the translation so stats can recognise our own output when the
      // framework re-injects it as a fresh node (Bootstrap's .tooltip-inner).
      stats.recordHit(trimmed, translated);
    } else {
      if (node.nodeValue !== original) node.nodeValue = original;
      recordTextWrite(node, original);
      stats.recordMiss(trimmed);
    }
  }

  function translateAttr(el, attr, translate, stats) {
    if (SKIP_ATTR_TAGS.has(el.nodeName)) return; // machine values only
    const live = el.getAttribute(attr);
    if (live === null) return;
    // Nothing to translate right now. Checked BEFORE rememberAttr on purpose, for
    // two reasons:
    //  - the framework blanked an attribute we already know (exactly what
    //    Bootstrap's tooltip _fixTitle() does to `title`): that emptiness is
    //    current state, not stale content, and writing the original back would
    //    resurrect a native tooltip the app deliberately suppressed. Returning
    //    early keeps the remembered Hungarian, which restore-to-Hungarian needs.
    //  - the attribute was blank the first time we saw it (`:title` bound to a
    //    value that has not loaded yet): remembering `""` as its original would
    //    make every later value of that attribute untranslatable, since the
    //    original is what we look up and `"".trim()` is falsy.
    if (!live.trim()) return;
    const original = rememberAttr(el, attr, live);
    const trimmed = original.trim();
    if (!trimmed) return;
    const translated = translate(trimmed);
    if (translated !== null) {
      if (el.getAttribute(attr) !== translated) {
        el.setAttribute(attr, translated);
      }
      recordAttrWrite(el, attr, translated);
      // Same reason as the text path: Bootstrap stashes this translated `title`
      // and renders it into .tooltip-inner, where it returns as a new text node.
      stats.recordHit(trimmed, translated);
    } else {
      if (el.getAttribute(attr) !== original) {
        el.setAttribute(attr, original);
      }
      recordAttrWrite(el, attr, original);
      stats.recordMiss(trimmed);
    }
  }

  function translateElementAttrs(el, translate, stats) {
    if (SKIP_ATTR_TAGS.has(el.nodeName)) return; // machine values only
    for (const attr of TRANSLATABLE_ATTRS) {
      if (el.getAttribute && el.getAttribute(attr) !== null) {
        translateAttr(el, attr, translate, stats);
      }
    }
    if (el.nodeName === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (BUTTON_INPUT_TYPES.has(type) && el.getAttribute('value') !== null) {
        translateAttr(el, 'value', translate, stats);
      }
    }
  }

  // NOTE: with time-slicing this may return BEFORE finishing — large walks
  // continue across scheduled slices. Callers must not assume synchronous completion.
  function walkAndTranslate(root, translate, stats, opts) {
    if (!root) return;
    const sliceSize = (opts && opts.sliceSize) || SLICE_SIZE;
    const schedule = (opts && opts.schedule) || defaultSchedule;
    const doc = root.ownerDocument || root;

    const items = [];
    collectItems(root, doc, items);

    const gen = ++walkGen; // a newer full walk aborts this one
    runSliced(
      items,
      (item) => {
        if (item.t === 'text') translateTextNode(item.node, translate, stats);
        else translateElementAttrs(item.el, translate, stats);
      },
      sliceSize,
      schedule,
      gen
    );
  }

  // Process a batch of mutation records. Dedupes by target so we don't
  // re-translate the same node multiple times in the same flush.
  function processMutations(mutations, translate, stats) {
    const subtreesToWalk = new Set();
    const textNodesToProcess = new Set();
    const attrChanges = []; // [el, attr]

    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const added of m.addedNodes) {
          if (added.nodeType === 1) subtreesToWalk.add(added);
          else if (added.nodeType === 3 && added.parentNode) {
            textNodesToProcess.add(added);
          }
        }
      } else if (m.type === 'characterData') {
        if (isOurTextWrite(m.target)) continue;
        // Real framework update — invalidate cache and re-translate.
        originalText.delete(m.target);
        textNodesToProcess.add(m.target);
      } else if (m.type === 'attributes' && TRANSLATABLE_ATTRS.includes(m.attributeName)) {
        if (isOurAttrWrite(m.target, m.attributeName)) continue;
        // A blank or removed value is a teardown, not new content: Bootstrap's
        // tooltip _fixTitle() blanks `title` once it has stashed it. Forgetting the
        // remembered Hungarian original there makes restore-to-Hungarian impossible
        // for every tooltip target, so keep it and skip the re-walk — a blank value
        // has nothing to translate anyway.
        const live = m.target.getAttribute(m.attributeName);
        if (live === null || !live.trim()) continue;
        // Genuinely new content: the remembered original is stale, so forget it and
        // re-translate from what the framework just wrote. Our own output coming
        // back — _restoreTitle() copying the stash into `title` — is filtered out by
        // the isOurAttrWrite guard above; adopting it here as the "original" is what
        // used to freeze an element in one language for the page's whole life.
        const map = originalAttrs.get(m.target);
        if (map) delete map[m.attributeName];
        attrChanges.push([m.target, m.attributeName]);
      }
    }

    const items = [];
    for (const sub of subtreesToWalk) collectItems(sub, sub.ownerDocument || sub, items);
    for (const node of textNodesToProcess) {
      let inWalked = false, p = node.parentNode;
      while (p) { if (subtreesToWalk.has(p)) { inWalked = true; break; } p = p.parentNode; }
      if (!inWalked) items.push({ t: 'text', node });
    }
    for (const [el, attr] of attrChanges) items.push({ t: 'attr', el, attr });

    runSliced(items, (item) => {
      if (item.t === 'text') translateTextNode(item.node, translate, stats);
      else if (item.t === 'el') translateElementAttrs(item.el, translate, stats);
      else translateAttr(item.el, item.attr, translate, stats);
    }, SLICE_SIZE, defaultSchedule);
  }

  const FLOOD_THRESHOLD = 2000; // mutation records / second sustained
  const COOLDOWN_MS = 750;

  function installObserver(root, translate, stats, opts) {
    const floodThreshold = (opts && opts.floodThreshold) || FLOOD_THRESHOLD;
    const cooldownMs = (opts && opts.cooldownMs) || COOLDOWN_MS;
    let pending = [];
    let scheduled = false;
    let paused = false;
    let floodCount = 0;
    let floodWindowStart = Date.now();
    let destroyed = false;
    let cooldownTimer = null;
    // Raw disconnect, reached through the prototype so it bypasses the public
    // `obs.disconnect` own-property below. The circuit-breaker MUST NOT go through
    // that wrapper: the wrapper is the teardown path and sets `destroyed`, which
    // would make the cooldown return early and leave the observer dead for the rest
    // of the page's life — translation would stop for good after one storm, on
    // exactly the busiest screens. Suspending is not tearing down.
    const rawDisconnect = () => MutationObserver.prototype.disconnect.call(obs);

    const observeOpts = {
      childList: true, subtree: true, characterData: true,
      // Same list as the mutation branch in processMutations: an attribute we write
      // while it is unrecognised there would be re-processed as if it were framework
      // content — a loop. (`value` on button-like INPUTs is translated but not
      // observed: the framework does not rewrite it, and watching it would report
      // every keystroke in every text field.)
      attributes: true, attributeFilter: TRANSLATABLE_ATTRS,
    };

    const obs = new MutationObserver((mutations) => {
      if (paused) return;
      const now = Date.now();
      if (now - floodWindowStart > 1000) { floodCount = 0; floodWindowStart = now; }
      floodCount += mutations.length;
      if (floodCount > floodThreshold) {
        paused = true;
        devCounters.circuitBreaks += 1;
        rawDisconnect();                       // suspend — never `destroyed`
        cooldownTimer = setTimeout(() => {
          cooldownTimer = null;
          if (destroyed) return;               // a caller tore us down meanwhile
          paused = false; floodCount = 0; floodWindowStart = Date.now();
          obs.observe(root, observeOpts);
          walkAndTranslate(root, translate, stats); // resettle after the storm
        }, cooldownMs);
        return;
      }
      for (const m of mutations) {
        if (m.type === 'characterData' && isOurTextWrite(m.target)) continue;
        if (m.type === 'attributes' && isOurAttrWrite(m.target, m.attributeName)) continue;
        pending.push(m);
      }
      if (!scheduled && pending.length > 0) {
        scheduled = true;
        defaultSchedule(() => {
          scheduled = false;
          const ms = pending; pending = [];
          processMutations(ms, translate, stats);
        });
      }
    });

    obs.observe(root, observeOpts);
    // Public teardown: permanent, and it cancels a pending resettle so a
    // language switch never leaves a zombie walk racing the new one.
    obs.disconnect = function () {
      destroyed = true;
      if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
      rawDisconnect();
    };
    return obs;
  }

  globalThis.BillingoTranslator = globalThis.BillingoTranslator || {};
  globalThis.BillingoTranslator.walkAndTranslate = walkAndTranslate;
  globalThis.BillingoTranslator.installObserver = installObserver;
  globalThis.BillingoTranslator.getDevCounters = () => ({ ...devCounters });
})();
