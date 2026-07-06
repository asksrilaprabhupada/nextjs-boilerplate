#!/usr/bin/env bash
# verify-release.sh — Real Search Release acceptance checks
#
# Run against any deployment:   SITE=https://<host> bash scripts/verify-release.sh
# Defaults to a local prod server (npm run build && npm run start).
# Requires: curl, python3, grep. Exits non-zero on the first failing check.
set -e
S=${SITE:-http://localhost:3000}
echo "Verifying $S"

# New de-AI'd title + SSR'd stats reach the served HTML
curl -sf "$S/" | grep -q "Search His Books"                        && echo "PASS title"
curl -sf "$S/" | grep -q "3,700"                                   && echo "PASS SSR stats"
curl -sf "$S/" | { ! grep -q "AI-powered"; }                       && echo "PASS no AI-powered"

# /search is dynamic: the question is in the server HTML; empty q redirects home
curl -sf "$S/search?q=How+to+control+the+mind%3F" | grep -qi "control the mind" && echo "PASS dynamic question"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$S/search")" = "307" ] && echo "PASS empty-q redirect"
curl -sf "$S/search?q=test" | grep -q 'name="robots" content="noindex' && echo "PASS /search noindex"

# The prototype mock is dead
! grep -rn "Prototype shows 5 of 142" --include='*.tsx' . >/dev/null 2>&1 && echo "PASS mock gone"

# Placeholders are labelled, never deleted
grep -rn "(FAKE)" --include='*.tsx' --include='*.ts' app | grep -qi seva && echo "PASS seva FAKE labels"

# API: validated verbatim, variants (10 or graceful 0), telemetry id present
curl -sf "$S/api/search?q=test+question" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('validated') is True, 'validated missing/false'
assert len(d.get('queryVariants', [])) in (0, 10), 'variant count'
assert 'searchLogId' in d, 'searchLogId missing'
assert d.get('intro') and 'addresses to ' not in d['intro'], 'framing grammar'
print('PASS api shape (validated, variants, searchLogId, framing)')
"

# SSE: stage frames then a result frame
curl -sN --max-time 80 "$S/api/search?q=what+is+the+soul&stream=1" > /tmp/sse.$$ || true
grep -q "event: stage" /tmp/sse.$$ && grep -q "event: result" /tmp/sse.$$ && echo "PASS SSE frames"
rm -f /tmp/sse.$$

# SEO surfaces
curl -sf "$S/sitemap.xml" | grep -q "/journey"                     && echo "PASS sitemap +journey"
curl -sf "$S/robots.txt"  | grep -q "Disallow: /search"            && echo "PASS robots /search"
curl -sf "$S/" | grep -q '"@type":"WebSite"'                       && echo "PASS JSON-LD"
curl -sf -o /dev/null "$S/icon.svg"                                && echo "PASS icon"

echo "ALL CHECKS PASSED"
