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
as_app yarn install --frozen-lockfile

# Explicit per-workspace builds: the root `yarn build` fans out to `contracts`
# too, which is a Foundry project — forge is not installed on the app server and
# does not need to be.
log "build engine"
as_app yarn workspace engine build

log "build api"
as_app yarn workspace api build

log "migrate (idempotent)"
as_app yarn workspace api migrate

# Hard restart. The orchestrator is in-process with real timers, so this
# interrupts any in-flight table — there is no blue/green here by design.
log "restart $SERVICE"
sudo systemctl restart "$SERVICE"

log "health check: $HEALTH_URL"
for i in $(seq 1 15); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null; then
    echo "healthy after ${i} attempt(s)"
    systemctl is-active "$SERVICE"
    exit 0
  fi
  sleep 2
done

echo "FATAL: $SERVICE did not become healthy within 30s" >&2
sudo journalctl -u "$SERVICE" -n 60 --no-pager >&2
exit 1
