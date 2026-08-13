#!/usr/bin/env bash
#
# T14 — trademark / vendored-vocabulary leak check (NFR-4, parent spec §6).
#
# The vendored library's enum names and the UNO trademark are permitted ONLY
# inside packages/engine. Every public surface — the API, the spectator web app,
# the reference agent, the skill file and the docs — must speak the product
# vocabulary from §6 instead:
#
#   SKIP -> PASS      REVERSE -> UTURN          DRAW_TWO -> GRAB2
#   WILD -> RAINBOW   WILD_DRAW_FOUR -> MEGARAINBOW
#
# This is trademark-driven, not stylistic. Fails the build on any match.
#
# ---------------------------------------------------------------------------
# Nominative-use carve-out (CLAUDE.md rule #2, spec 06 T14)
# ---------------------------------------------------------------------------
# ONE exception exists: human-facing marketing copy may refer to the UNO mark
# *nominatively* — to tell a reader which genre of card game this is — because
# without it visitors could not tell what the product does (the confusion this
# carve-out was added to fix). To claim it, put this marker on the SAME LINE:
#
#   trademark-lint:nominative-ok
#
# The carve-out is deliberately narrow, and the marker does NOT disable the
# check on that line:
#   - It excuses the bare word `uno` ONLY. The vendored enum names on a marked
#     line are still a hard failure — those are vocabulary leaks, not
#     trademark reference, and no copy decision can license them.
#   - Every marked line is printed in CI as a standing audit trail, so the
#     total number of nominative uses stays visible and reviewable.
#
# Conditions of use (do not add a marker without meeting all of them):
#   - Prose or FAQ body copy only — NEVER a <title>, <h1>, logo, brand line,
#     domain, or SEO keyword field. Those are branding, not reference, and
#     fall outside nominative fair use.
#   - The page must carry the Mattel disclaimer (see home.html's footer).
#   - Reference only. Never imply affiliation, sponsorship, or endorsement,
#     and never imitate Mattel's card art or trade dress.
set -uo pipefail

cd "$(dirname "$0")/.."

# Public surfaces. packages/engine is deliberately absent: it owns the vendored
# vocabulary and is the only place allowed to name it.
SCAN_PATHS=(packages/api packages/web packages/reference-agent)
[ -f skill.md ] && SCAN_PATHS+=(skill.md)
[ -d docs ] && SCAN_PATHS+=(docs)

# Word-boundary matched so ordinary English survives: "skipped", "Skips",
# "wildcard" and "reversed" are all fine — only the bare terms are the leak.
# Underscore is a word character, so the compound enum names need their own
# alternatives (\bwild\b does not match WILD_DRAW_FOUR).
PATTERN='\b(uno|skip|reverse|wild|draw_two|wild_draw_four)\b'

EXCLUDE_DIRS=(--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=vendor-dist
              --exclude-dir=coverage --exclude-dir=.git --exclude-dir=vendor)
EXCLUDE_FILES=(--exclude=yarn.lock --exclude=package-lock.json --exclude='*.map'
               --exclude='*.tsbuildinfo')

existing=()
for path in "${SCAN_PATHS[@]}"; do
  [ -e "$path" ] && existing+=("$path")
done

if [ ${#existing[@]} -eq 0 ]; then
  echo "[lint:trademark] no public surfaces to scan yet — passing."
  exit 0
fi

matches=$(grep -rniE "$PATTERN" "${EXCLUDE_DIRS[@]}" "${EXCLUDE_FILES[@]}" "${existing[@]}" 2>/dev/null || true)

# Partition the hits: lines claiming the nominative carve-out vs. everything
# else. `grep -F ... || true` on an empty input is a no-op, so both may be empty.
MARKER='trademark-lint:nominative-ok'
VENDOR_TERMS='\b(skip|reverse|wild|draw_two|wild_draw_four)\b'

marked=$(printf '%s' "$matches" | grep -F "$MARKER" || true)
violations=$(printf '%s' "$matches" | grep -vF "$MARKER" || true)

# A marker excuses the trademark, never a vocabulary leak. A marked line that
# also names a vendored enum is still a hard failure.
abuse=$(printf '%s' "$marked" | grep -iE "$VENDOR_TERMS" || true)

if [ -n "$abuse" ]; then
  echo "[lint:trademark] FAILED — '$MARKER' used to smuggle vendored vocabulary:"
  echo
  echo "$abuse" | sed 's/^/  /'
  echo
  echo "The carve-out covers the bare UNO trademark ONLY. Vendored enum names are"
  echo "a vocabulary leak on any line, marked or not — use the §6 product terms."
  exit 1
fi

if [ -n "$violations" ]; then
  echo "[lint:trademark] FAILED — vendored UNO vocabulary found outside packages/engine:"
  echo
  echo "$violations" | sed 's/^/  /'
  echo
  echo "Use the product vocabulary (spec §6) instead:"
  echo "  SKIP -> PASS      REVERSE -> UTURN          DRAW_TWO -> GRAB2"
  echo "  WILD -> RAINBOW   WILD_DRAW_FOUR -> MEGARAINBOW"
  echo "If a match is ordinary English, reword it — these surfaces are public."
  echo
  echo "Human-facing copy may reference the UNO mark nominatively — see the"
  echo "carve-out conditions at the top of this script before adding a marker."
  exit 1
fi

echo "[lint:trademark] OK — scanned ${existing[*]}; no vendored vocabulary outside packages/engine."

# Standing audit trail: keep every nominative use visible in the CI log so the
# count can't creep upward unnoticed.
if [ -n "$marked" ]; then
  echo "[lint:trademark] $(printf '%s\n' "$marked" | wc -l | tr -d ' ') approved nominative UNO reference(s):"
  echo "$marked" | sed 's/^/  /'
fi
