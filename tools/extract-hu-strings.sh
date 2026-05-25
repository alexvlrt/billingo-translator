#!/usr/bin/env bash
# Extracts all Hungarian UI strings from a logged-in Billingo session.
# Usage: ./tools/extract-hu-strings.sh <netscape-cookie-jar.txt>
# Writes one string per line to stdout. Designed for the file to be redirected
# to tools/hu-strings.txt.

set -euo pipefail

COOKIE_FILE="${1:?usage: $0 <netscape-cookie-jar.txt>}"

if [[ ! -f "$COOKIE_FILE" ]]; then
  echo "ERROR: cookie file not found: $COOKIE_FILE" >&2
  exit 1
fi

# Auth check: the dashboard URL redirects to /auth/login if cookies are stale.
final_url=$(curl -sL -A 'Mozilla/5.0' \
  -b "$COOKIE_FILE" -c "$COOKIE_FILE" \
  -o /dev/null -w '%{url_effective}' \
  'https://app.billingo.hu/n/dashboard')

if [[ "$final_url" == *"/auth/login"* ]]; then
  echo "ERROR: cookies are stale or invalid; re-export from logged-in browser." >&2
  exit 2
fi

# Fetch authenticated dashboard, extract __NUXT__ inline state, scrape unique
# strings containing Hungarian-specific characters (ő, ű, plus the standard
# accents that disambiguate from generic European text).
curl -sL -A 'Mozilla/5.0' \
  -b "$COOKIE_FILE" -c "$COOKIE_FILE" \
  'https://app.billingo.hu/n/dashboard' \
| python3 -c '
import re, sys
html = sys.stdin.read()
m = re.search(r"window\.__NUXT__=(.*?)</script>", html, re.DOTALL)
if not m:
    print("ERROR: __NUXT__ state not found in dashboard HTML", file=sys.stderr)
    sys.exit(3)
state = m.group(1)
strings = set(re.findall(r"\"([^\"]{2,400}[őűáéíóöúüŐŰÁÉÍÓÖÚÜ][^\"]{0,400})\"", state))
for s in sorted(strings):
    print(s)
'
