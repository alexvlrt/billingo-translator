// tools/lib/filters.js
// Fonctions pures partagées par build-shards.js et diagnose-extension.js.
// Porté depuis diagnose-extension.js (isLikelyHu) et extract-all-strings.sh
// (looks_like_noise, regex identiques).

export const HU_RE = /[őűáéíóöúüŐŰÁÉÍÓÖÚÜ]/;

// Une balise bien formée : ouvrante ou fermante, attributs sans chevrons, éventuel
// slash auto-fermant. Volontairement stricte pour ne pas confondre avec « a < b ».
const HTML_TAG = /<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/i;

// Une chaîne porteuse de balises est rendue par v-html : le navigateur la parse,
// donc elle n'apparaît JAMAIS telle quelle dans un nœud texte et ne peut jamais
// matcher — c'est une clé morte, et il y en avait 198 pour 72 Ko dans _common,
// parsés à chaque page.
//
// DÉLIBÉRÉMENT HORS de looksLikeNoise : extractStrings() teste looksLikeNoise sur la
// chaîne ENTIÈRE avant d'en extraire les fragments détagués, donc l'y mettre jetait
// aussi le texte utile (« Pro csomagot »). Ce prédicat sert au moment de décider
// qu'une chaîne devient une CLÉ (planShards), pas au moment de la fouiller.
export function hasHtmlMarkup(s) {
  return HTML_TAG.test(s);
}

// Signature d'un commentaire de doc : « nom: type // … » ou « nom?: type, // … ».
const DOC_COMMENT = /^[a-zA-Z_$][\w$]*\??\s*:\s*[^,]*,?\s*\/\//;

export function looksLikeNoise(s) {
  if (s.length < 2 || s.length > 500) return true;
  if (s.startsWith(',') || s.startsWith(':')) return true;
  if (s.endsWith(':') && !s.includes(' ') && s.length <= 60) return true;
  if (/^[\d\s.,:/\-+()%€$£¥]+$/.test(s)) return true;
  if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/.test(s)) return true;
  if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(s)) return true;
  if (/^[a-z]+(?:_[a-z0-9]+)+$/.test(s)) return true;
  if (/^[a-z]+(?:-[a-z0-9]+)+$/.test(s) && !s.includes(' ')) return true;
  if (/^[A-Z][A-Z0-9_]+$/.test(s)) return true;
  if (/^[a-zA-Z_][\w-]*$/.test(s) && s.includes('_')) return true;
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('//')) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return true;
  if (s.startsWith('/') && !s.includes(' ')) return true;
  if (/^[{[]|^function|^const |^let |^var |^=>/.test(s)) return true;
  if (/^[0-9a-f]{16,}$/.test(s)) return true;
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?Z?)?$/.test(s)) return true;
  // Résidus de commentaires de doc TypeScript/Vue aspirés depuis le bundle :
  // « id: string | number, // Szekció egyedi azonosítója », « title?: string, // … ».
  if (DOC_COMMENT.test(s)) return true;
  return false;
}

export function makeHuFilter(dictKeys, dictValues) {
  return function isLikelyHu(s) {
    if (HU_RE.test(s)) return true;
    if (dictKeys.has(s)) return true;
    if (dictValues.has(s)) return false;
    return false;
  };
}

export const COMMON_ZONE_THRESHOLD = 3;

export const CHROME_STRINGS = new Set([
  'Mentés', 'Mégse', 'Bezár', 'Vissza', 'Tovább', 'Törlés', 'Szerkesztés',
  'Új', 'Keresés', 'Letöltés', 'Műveletek', 'Beállítások', 'Kijelentkezés',
  'Igen', 'Nem', 'Rendben', 'Betöltés...', 'Kötelező mező',
  'A mező kitöltése kötelező', 'Sikeres mentés', 'Hiba történt',
  'Biztosan törölni szeretnéd?',
]);
