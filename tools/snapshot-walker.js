// tools/snapshot-walker.js
// Extraction des strings rendues (texte + attributs). Self-contained pour être
// sérialisable par Playwright page.evaluate() et copiable dans evaluate_script
// (MCP). doc par défaut = document (contexte navigateur) ; les tests passent un
// document jsdom.

export function extractRenderedStrings(doc = document) {
  const win = doc.defaultView || globalThis;
  const NodeFilter = win.NodeFilter;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const BTN = new Set(['submit', 'button', 'reset']);
  const out = new Set();

  const tw = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentNode;
      if (!p || SKIP.has(p.nodeName)) return NodeFilter.FILTER_REJECT;
      const v = n.nodeValue && n.nodeValue.trim();
      return v ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let n;
  while ((n = tw.nextNode())) out.add(n.nodeValue.trim());

  const ew = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  let el = ew.nextNode();
  while (el) {
    if (!SKIP.has(el.nodeName)) {
      for (const a of ATTRS) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v && v.trim()) out.add(v.trim());
      }
      if (el.nodeName === 'INPUT') {
        const t = (el.getAttribute('type') || '').toLowerCase();
        if (BTN.has(t)) {
          const v = el.getAttribute('value');
          if (v && v.trim()) out.add(v.trim());
        }
      }
    }
    el = ew.nextNode();
  }
  return [...out];
}
