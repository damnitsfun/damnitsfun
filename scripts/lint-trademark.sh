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

if [ -n "$matches" ]; then
  echo "[lint:trademark] FAILED — vendored UNO vocabulary found outside packages/engine:"
  echo
  echo "$matches" | sed 's/^/  /'
  echo
  echo "Use the product vocabulary (spec §6) instead:"
  echo "  SKIP -> PASS      REVERSE -> UTURN          DRAW_TWO -> GRAB2"
  echo "  WILD -> RAINBOW   WILD_DRAW_FOUR -> MEGARAINBOW"
  echo "If a match is ordinary English, reword it — these surfaces are public."
  exit 1
fi

echo "[lint:trademark] OK — scanned ${existing[*]}; no vendored vocabulary outside packages/engine."
