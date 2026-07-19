#!/usr/bin/env bash
#
# Trademark / vendored-vocabulary leak check.
#
# STUB (sub-spec 01): the real grep logic lands in sub-spec 06 / T14. For now
# this exists so the CI pipeline shape is in place and `yarn lint` has a first
# stage to run. It must exit 0.
#
# When implemented (T14): grep packages/api, packages/web, and skill.md for the
# vendored library's literal enum names (SKIP, REVERSE, WILD_DRAW_FOUR, ...),
# case-insensitive, and fail the build if any appear outside packages/engine.
set -euo pipefail

echo "[lint:trademark] stub — real vendored-vocabulary grep lands in T14 (sub-spec 06). Passing."
exit 0
