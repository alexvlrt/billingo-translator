#!/usr/bin/env bash
# Comprehensive extraction: crawl multiple authenticated Billingo pages and
# extract every visible string (text nodes + translatable attributes), not
# just the ones containing Hungarian-specific diacritics.
#
# Usage: ./tools/extract-all-strings.sh <netscape-cookie-jar.txt>
# Writes one unique string per line to stdout, alphabetically sorted.

set -euo pipefail

COOKIE_FILE="${1:?usage: $0 <netscape-cookie-jar.txt>}"

if [[ ! -f "$COOKIE_FILE" ]]; then
  echo "ERROR: cookie file not found: $COOKIE_FILE" >&2
  exit 1
fi

ROUTES=(
  "/n/dashboard"
  "/n/partner/list"
  "/n/product/list"
  "/n/bank-account/list"
  "/n/profile"
  "/n/account"
  "/n/subscription"
  "/n/settings"
  "/n/document/list"
  "/n/document-list"
  "/n/document/create"
  "/n/expense/list"
  "/n/integrations"
  "/n/api-keys"
  "/n/notifications"
  "/n/users"
  "/n/role"
  "/n/bob/dashboard"
  "/n/bob/connection-wizard"
  "/n/cegjelzo/dashboard"
  "/n/cegjelzo/partners"
  "/n/marketplace"
)

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

for route in "${ROUTES[@]}"; do
  out="$TMPDIR/$(echo "$route" | tr / _).html"
  curl -sL -A 'Mozilla/5.0' \
    -b "$COOKIE_FILE" -c "$COOKIE_FILE" \
    "https://app.billingo.hu$route" \
    -o "$out" \
    -w "%{url_effective} %{http_code} %{size_download} bytes\n" >&2
done

# Extract all visible strings from each fetched HTML using Python.
# Strategy: parse HTML, walk text nodes, also pull translatable attributes,
# also scrape __NUXT__ state for strings we might have missed.
python3 - "$TMPDIR" <<'PYEOF'
import sys, os, re, html
from html.parser import HTMLParser

SKIP_TAGS = {'script', 'style', 'noscript', 'textarea'}
ATTRS_TO_GRAB = {'placeholder', 'title', 'aria-label', 'alt'}
BUTTON_INPUT_TYPES = {'submit', 'button', 'reset'}

class TextHarvester(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip_depth = 0
        self.found = set()
        self.cur_input_type = None

    def handle_starttag(self, tag, attrs):
        ad = dict(attrs)
        if tag in SKIP_TAGS:
            self.skip_depth += 1
            return
        for a in ATTRS_TO_GRAB:
            if a in ad and ad[a]:
                v = ad[a].strip()
                if v:
                    self.found.add(v)
        if tag == 'input':
            t = (ad.get('type') or '').lower()
            if t in BUTTON_INPUT_TYPES and ad.get('value'):
                v = ad['value'].strip()
                if v:
                    self.found.add(v)

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self.skip_depth > 0:
            self.skip_depth -= 1

    def handle_data(self, data):
        if self.skip_depth > 0:
            return
        s = data.strip()
        if s:
            self.found.add(s)

CAMEL_CASE_RE = re.compile(r'^[A-Z][a-z]+(?:[A-Z][a-z]+)+$')
SCREAMING_SNAKE_RE = re.compile(r'^[A-Z][A-Z0-9_]+$')
SNAKE_CASE_RE = re.compile(r'^[a-z]+(?:_[a-z0-9]+)+$')
KEBAB_CASE_RE = re.compile(r'^[a-z]+(?:-[a-z0-9]+)+$')

def looks_like_noise(s):
    """Filter out strings that are obviously not UI text."""
    if len(s) < 2 or len(s) > 500:
        return True
    # i18n key leakage: starts with comma (object-pair separator), ends with colon.
    if s.startswith((',', ':')):
        return True
    if s.endswith(':') and ' ' not in s and len(s) <= 60:
        return True
    # ALL ASCII digits/punct/spaces — likely IDs, dates, money.
    if re.fullmatch(r'[\d\s.,:/\-+()%€$£¥]+', s):
        return True
    # Identifier-shaped strings (CamelCase, snake_case, kebab-case, SCREAMING).
    if CAMEL_CASE_RE.match(s):
        return True
    if SNAKE_CASE_RE.match(s):
        return True
    if KEBAB_CASE_RE.match(s) and ' ' not in s:
        return True
    if SCREAMING_SNAKE_RE.match(s):
        return True
    # CSS / class name / JS identifier with underscore.
    if re.fullmatch(r'[a-zA-Z_][\w-]*', s) and '_' in s:
        return True
    # URL.
    if s.startswith(('http://', 'https://', '//')):
        return True
    # Email.
    if re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', s):
        return True
    # File path.
    if s.startswith('/') and ' ' not in s:
        return True
    # Looks like JSON / JS code.
    if s.startswith(('{', '[', 'function', 'const ', 'let ', 'var ', '=>')):
        return True
    # SHA / hex blobs.
    if re.fullmatch(r'[0-9a-f]{16,}', s):
        return True
    # ISO date / datetime.
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?Z?)?', s):
        return True
    return False

tmpdir = sys.argv[1]
all_strings = set()
for fname in os.listdir(tmpdir):
    path = os.path.join(tmpdir, fname)
    try:
        body = open(path, 'r', encoding='utf-8', errors='replace').read()
    except Exception:
        continue
    # 1. Walk visible HTML text + translatable attrs
    h = TextHarvester()
    try:
        h.feed(body)
    except Exception:
        pass
    all_strings |= h.found

    # 2. Also harvest from __NUXT__ inline state with a broad regex
    m = re.search(r'window\.__NUXT__=(.*?)</script>', body, re.DOTALL)
    if m:
        state = m.group(1)
        # All quoted strings in the state, length 2-300
        for s in re.findall(r'"([^"\\]{2,300})"', state):
            all_strings.add(s)

# Trim every captured string and dedupe (post-trim) to match the runtime
# walker, which always trims before lookup.
trimmed_strings = {s.strip() for s in all_strings if s.strip()}

# Filter noise.
filtered = sorted({s for s in trimmed_strings if not looks_like_noise(s)})
for s in filtered:
    print(s)
PYEOF
