#!/usr/bin/env bash
#
# Runs ON the EC2 instance, piped in over SSH by the reusable deploy workflow:
#
#   ssh host "ENV_NAME=staging APP_ROOT=/opt/damnits/staging bash -s" \
#     < deploy/remote-deploy.sh
#
# The source tree has already been rsync'd to $APP_ROOT/app. .env was excluded
# and data/ lives outside the app dir entirely, so neither is ever touched.
#
# Assumes the one-time setup in docs/deploy-aws-ec2.md §2: the `damnits` service
# user, the sudoers snippet, and the damnits-api@.service template unit.
set -euo pipefail

ENV_NAME=${ENV_NAME:-production}
APP_ROOT=${APP_ROOT:-/opt/damnits/$ENV_NAME}
APP_DIR="$APP_ROOT/app"
SERVICE="damnits-api@${ENV_NAME}"
SERVICE_USER=${SERVICE_USER:-damnits}
# Loopback, so this check passes or fails on the app alone — nginx and TLS are
# proven separately by the workflow's public health check.
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:8080/api/battleground/config}

log() { printf '\n\033[1m==> [%s] %s\033[0m\n' "$ENV_NAME" "$*"; }

# Build as the DEPLOY user, which owns app/. rsync -a implies -p and stamps the
# source root's mode onto the destination, so a tree the deploy user only had
# group-write on would lose setgid/g+w on every sync and the build would then
# fail to create node_modules/. Owning it outright removes that whole class of
# failure — and matches the unit's ProtectSystem=strict, under which the service
# already treats app/ as read-only.
as_deploy() { env -C "$APP_DIR" "$@"; }

# Migrate as the SERVICE user: it creates the SQLite file (plus -wal/-shm), and
# whoever creates it must be whoever later writes to it. This is also the only
# step that reads .env, which is 0640 ubuntu:damnits — group-readable so the
# service user can load it, never world-readable.
as_app() { sudo -u "$SERVICE_USER" env -C "$APP_DIR" "$@"; }

# Refuse to deploy into an environment that was never set up, rather than
# creating a half-configured one.
if [[ ! -d "$APP_DIR" ]]; then
  echo "FATAL: $APP_DIR does not exist. Run the one-time setup for the '$ENV_NAME'" >&2
  echo "       environment first — docs/deploy-aws-ec2.md §2." >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "FATAL: $APP_DIR/.env is missing. It lives on the server only and is never" >&2
  echo "       synced by CI. See docs/deploy-aws-ec2.md §2.6." >&2
  exit 1
fi

cd "$APP_DIR"

log "yarn install (native modules rebuild here, on this machine's arch)"
as_deploy yarn install --frozen-lockfile

# Explicit per-workspace builds: the root `yarn build` fans out to `contracts`
# too, which is a Foundry project — forge is not installed on the app server and
# does not need to be.
log "build engine"
as_deploy yarn workspace engine build

log "build api"
as_deploy yarn workspace api build

# Run the compiled entrypoint directly rather than `yarn workspace api migrate`.
# Two reasons, both load-bearing:
#   1. `yarn workspace` sets cwd to packages/api, and loadConfig() reads .env
#      from cwd and SKIPS IT SILENTLY when absent — so the workspace form
#      migrates the default ./data/damnits.sqlite *relative to packages/api*,
#      i.e. a stray database inside app/, never this environment's real one.
#   2. The `migrate` script is `yarn build && node ...`; the api was already
#      built above, and re-running tsc here would write into an ubuntu-owned
#      dist/ as the damnits user.
log "migrate (idempotent)"
as_app node packages/api/dist/db/migrate.js

# Report tunables this environment's .env pins to something the code no longer
# defaults to. Advisory only — it never fails the deploy, because overriding a
# tunable is a legitimate choice. It exists because the opposite case is silent:
# a retuned default that a stale .env line quietly swallows, so the deploy is
# green and the fix does nothing. That shipped three times in one day
# (TABLE_SIZE twice, RAINBOW_STORM_CHANCE once).
log "config drift check"
as_app node packages/api/dist/check-env-drift.js || true

# Hard restart. The orchestrator is in-process with real timers, so this
# interrupts any in-flight table — there is no blue/green here by design.
log "restart $SERVICE"
sudo systemctl restart "$SERVICE"

# How long to wait for the service to answer after a restart.
#
# This is a boot budget, not a liveness check. The API is synchronous
# (better-sqlite3) and opens a database that is already 1.7 GB across ~2.5M
# session_events, so it can take the better part of a minute to serve its first
# request — during which it is listening but not yet answering. The production
# deploy of a3d8992 spent ~53s in exactly that state and was failed by a budget
# of 15 x (5 + 2) = 95s, having done every other step correctly: source synced,
# built, migrated, restarted, serving. A slow boot is not a failed deploy.
#
# The seconds in the FATAL line are DERIVED, not typed. The old message said
# "within 30s" while the loop actually waited 95s, which made a near-miss read
# as an instant hard failure and sent the first investigation down the wrong path.
HEALTH_ATTEMPTS=${HEALTH_ATTEMPTS:-40}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-5}
HEALTH_SLEEP=${HEALTH_SLEEP:-2}
health_budget_s=$(( HEALTH_ATTEMPTS * (HEALTH_TIMEOUT + HEALTH_SLEEP) ))

log "health check: $HEALTH_URL (up to ${health_budget_s}s)"
started_at=$SECONDS
for i in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if curl -fsS --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" >/dev/null; then
    echo "healthy after ${i} attempt(s), $(( SECONDS - started_at ))s"
    systemctl is-active "$SERVICE"
    exit 0
  fi
  # A restart that is merely slow looks identical to one that is stuck, for
  # minutes. Say which it is while it is happening, so a watcher does not have to
  # guess from a wall of curl errors.
  if [ $(( i % 5 )) -eq 0 ]; then
    log "  still waiting — ${i}/${HEALTH_ATTEMPTS} attempts, $(( SECONDS - started_at ))s elapsed"
  fi
  sleep "$HEALTH_SLEEP"
done

echo "FATAL: $SERVICE did not become healthy within ${health_budget_s}s" >&2
sudo journalctl -u "$SERVICE" -n 60 --no-pager >&2
exit 1
