#!/usr/bin/env bash
#
# Runs ON the EC2 instance, piped in over SSH by .github/workflows/deploy.yml
# (`ssh host 'bash -s' < deploy/remote-deploy.sh`). The source tree has already
# been rsync'd to $APP_DIR at this point; .env and data/ were excluded and are
# untouched.
#
# Assumes the one-time setup in docs/deploy-aws-ec2.md §2: the `damnits` service
# user, the sudoers snippet, and the damnits-api systemd unit.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/damnits/app}
SERVICE=${SERVICE:-damnits-api}
SERVICE_USER=${SERVICE_USER:-damnits}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:8080/api/battleground/config}

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
as_app() { sudo -u "$SERVICE_USER" env -C "$APP_DIR" "$@"; }

cd "$APP_DIR"

# Fail loudly and early rather than booting a server with no config.
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "FATAL: $APP_DIR/.env is missing. It lives on the server only and is never" >&2
  echo "       synced by CI. See docs/deploy-aws-ec2.md §2.6." >&2
  exit 1
fi

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
