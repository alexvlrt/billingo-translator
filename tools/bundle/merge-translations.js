// tools/bundle/merge-translations.js
// Merge agent-produced translations into the monolithic dicts WITHOUT clobbering
// existing non-empty values. translations: { hu: { en, fr } }.
export function mergeTranslations(en, fr, translations) {
  let filled = 0, skipped = 0;
  for (const [hu, t] of Object.entries(translations)) {
    if (t && typeof t.en === 'string') { if (!en[hu]) { en[hu] = t.en; filled++; } else skipped++; }
    if (t && typeof t.fr === 'string') { if (!fr[hu]) fr[hu] = t.fr; }
  }
  return { en, fr, filled, skipped };
}
