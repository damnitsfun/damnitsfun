# Deploying damnits.fun to AWS EC2 (with GitHub Actions)

A complete, copy-pasteable tutorial for putting this monorepo on a single EC2
instance and keeping it updated from `main` via GitHub Actions.

**What you end up with**

```
Browser / agent
      │  https://damnits.fun
      ▼
   nginx (:80 → :443, TLS via certbot)
      │  proxy_pass http://127.0.0.1:8080
      ▼
   node packages/api/dist/server.js      ← systemd unit `damnits-api`
      ├── serves /  /battleground  /profile  /claim  /skill.md  (packages/web/public)
      ├── serves /api/battleground/*  (+ deprecated /api/arena/* alias)
      ├── SQLite file at ./data/damnits.sqlite
      └── talks to BSC testnet (chain ID 97) when the chain vars are set
```

Push to `main` → GitHub Actions runs the test suite → rsyncs the working tree to
the instance → `yarn install` + build + migrate on the box → `systemctl restart`
→ health check. Rollback is a `git revert` (or re-running an older workflow run).

---

## Before you start: three facts about this app that shape the deployment

Read these — they explain *why* the tutorial does things the way it does.

1. **It is one process, and it must stay one process.** The orchestrator
   (`packages/api/src/orchestrator.ts`) runs in-process with real timers, and
   persistence is `better-sqlite3` (synchronous, single file). You **cannot** run
   two instances behind a load balancer — they would both drive the same tables
   and fight over the same SQLite file. One instance, vertically scaled. No ASG
   with `desired > 1`, no ECS with two tasks.

2. **`better-sqlite3` is a native module, so `node_modules` is not portable.**
   Do not build on the GitHub runner and ship `node_modules`. This tutorial runs
   `yarn install` *on the instance*, which is also why the instance needs
   `build-essential` and `python3`.

3. **The repo layout must survive the deploy.** `server.ts` resolves the static
   UI and `skill.md` relative to the compiled file:

   ```
   packages/api/dist/../../web/public   →  packages/web/public/{home,index}.html
   packages/api/dist/../../..           →  repo root, for /skill.md
   ```

   So deploy the **whole repo tree**, not just `packages/api`. And `.env` and the
   SQLite path are resolved from **`process.cwd()`** (`loadConfig` calls
   `process.loadEnvFile(resolve(process.cwd(), '.env'))`), which is why the
   systemd unit sets `WorkingDirectory` to the repo root.

Also note: the root `yarn build` / `yarn test` scripts fan out to **all**
workspaces, including `contracts`, whose scripts are `forge build` / `forge test`.
Foundry is not installed on the app server and does not need to be — the deploy
builds `engine` and `api` explicitly. Contracts are deployed separately with
`forge script` (see [`docs/deployment.md`](./deployment.md)).

---

## Part 1 — Provision the EC2 instance

### 1.1 Launch

| Setting | Value | Why |
|---|---|---|
| AMI | **Ubuntu Server 24.04 LTS** | Current LTS; NodeSource ships Node 24 for it. |
| Instance type | **t4g.small** (arm64) or **t3.small** (x86_64) | 2 GB RAM. `tsc` across the workspaces needs more than a 1 GB nano gives you. |
| Storage | **20 GB gp3** | Repo + `node_modules` + SQLite + logs. |
| Key pair | create/choose one | You need SSH for the first-time setup. |
| Elastic IP | **allocate and associate one** | A stopped/started instance changes its public IP otherwise, breaking DNS and your OAuth callbacks. |

> Pick **one** architecture and stick with it. `better-sqlite3` publishes
> prebuilt binaries for both `linux-x64` and `linux-arm64`, but if a prebuild is
> missing it compiles from source — that is what `build-essential` is for.

### 1.2 Security group

| Type | Port | Source |
|---|---|---|
| SSH | 22 | **Your IP only** (`x.x.x.x/32`) — not `0.0.0.0/0` |
| HTTP | 80 | `0.0.0.0/0` (certbot's HTTP-01 challenge + the redirect to HTTPS) |
| HTTPS | 443 | `0.0.0.0/0` |

**Do not open 8080.** The Node process binds `0.0.0.0:8080`
(`server.ts:486`), and nginx reaches it over loopback. Leaving 8080 open to the
world would expose the API bypassing TLS and any rate limiting you add later.

### 1.3 DNS for `damnits.fun`

Two records, both `A`, both pointing at the Elastic IP:

```
damnits.fun.       A   <elastic-ip>     # apex — the canonical origin
www.damnits.fun.   A   <elastic-ip>     # redirected to the apex by nginx
```

The apex **must** be an `A` record — CNAME at the zone apex is invalid, which is
exactly why this setup uses an Elastic IP rather than chasing a changing public
IP. `www` is an `A` record here too (rather than a CNAME to the apex) purely
because it costs nothing and keeps both names on one mechanism.

Where you create them depends on where `damnits.fun` is managed:

- **Route 53** — create a public hosted zone for `damnits.fun`, add the two `A`
  records, then copy the four `NS` values from the zone into your registrar's
  nameserver settings. Propagation is minutes-to-hours; don't start certbot
  until it's done.
- **Registrar's own DNS** (Namecheap, Porkbun, Cloudflare, …) — just add the two
  `A` records there. Nothing about this deployment needs Route 53.
- **Cloudflare specifically** — set both records to **DNS only** (grey cloud)
  for the initial certbot run. Orange-cloud proxying intercepts the HTTP-01
  challenge and the issuance fails. You can re-enable the proxy afterwards, but
  then keep Cloudflare's SSL mode on **Full (strict)** so it doesn't strip the
  origin certificate you just installed.

Confirm before moving on — a wrong answer here wastes a Let's Encrypt rate-limit
slot:

```bash
dig +short damnits.fun A
dig +short www.damnits.fun A     # both should print your Elastic IP
```

**The apex is canonical.** `PUBLIC_BASE_URL=https://damnits.fun`, the OAuth
`redirect_uri` is derived from it, and nginx 301s `www` → apex. Don't mix the
two.

---

## Part 2 — First-time server setup

SSH in (`ssh -i key.pem ubuntu@<elastic-ip>`) and run these once.

### 2.1 Base packages + Node 24

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y build-essential python3 git curl rsync sqlite3 nginx

# Node 24 (Node 20 is EOL — never use it; .nvmrc pins 24)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# yarn classic v1 — this repo is yarn workspaces, do not substitute npm/pnpm
sudo corepack enable
sudo corepack prepare yarn@1.22.22 --activate

node -v    # v24.x
yarn -v    # 1.22.22
```

We install Node via apt (not nvm) on purpose: systemd needs a stable absolute
path (`/usr/bin/node`), and nvm's shell-function shims are not available to it.

### 2.2 Swap (recommended on a 2 GB box)

TypeScript compilation of five workspaces plus a native-module build can spike
past 2 GB and get OOM-killed mid-deploy.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 2.3 A dedicated service user and app directory

Don't run the app as `ubuntu`, and don't run it as root.

```bash
sudo useradd --system --create-home --home-dir /opt/damnits --shell /bin/bash damnits
sudo mkdir -p /opt/damnits/app /opt/damnits/backups
sudo chown -R damnits:damnits /opt/damnits
```

The deploy user (`ubuntu`) needs to write into `/opt/damnits/app` via rsync and
run commands as `damnits`. Simplest workable setup: make `ubuntu` a member of the
`damnits` group and give the tree group-write.

```bash
sudo usermod -aG damnits ubuntu
sudo chmod -R g+w /opt/damnits
# new files inherit the group, so rsync-created files stay writable by both
sudo chmod g+s /opt/damnits/app
```

Log out and back in for the group change to apply to your shell.

### 2.4 Let the deploy restart the service without a password

```bash
sudo tee /etc/sudoers.d/damnits-deploy >/dev/null <<'EOF'
ubuntu ALL=(root) NOPASSWD: /bin/systemctl restart damnits-api, /bin/systemctl status damnits-api, /bin/systemctl is-active damnits-api
ubuntu ALL=(damnits) NOPASSWD: ALL
EOF
sudo chmod 440 /etc/sudoers.d/damnits-deploy
sudo visudo -c    # must print "parsed OK"
```

This is deliberately narrow: the CI deploy key can restart *this* unit and run
commands as the unprivileged `damnits` user — it cannot become root.

### 2.5 Seed the working tree

The very first copy comes from your laptop (later ones come from Actions):

```bash
# from your laptop, in the repo root
rsync -az --delete \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' \
  --exclude 'vendor-dist/' --exclude '.env' --exclude 'data/' \
  --exclude 'packages/contracts/lib/' --exclude 'packages/contracts/out/' \
  -e "ssh -i key.pem" \
  ./ ubuntu@<elastic-ip>:/opt/damnits/app/
```

### 2.6 Write the production `.env`

`.env` is gitignored and **never** travels through CI. It lives on the box only.

```bash
sudo -u damnits cp /opt/damnits/app/.env.example /opt/damnits/app/.env
sudo -u damnits chmod 600 /opt/damnits/app/.env
sudo -u damnits nano /opt/damnits/app/.env
```

The values that actually differ from the local defaults:

```ini
PORT=8080
DATABASE_PATH=/opt/damnits/app/data/damnits.sqlite

# MUST be the real https origin. It is used to build claim URLs and the OAuth
# redirect_uri, and cookieSecure is derived from it starting with "https://".
PUBLIC_BASE_URL=https://damnits.fun

# 3s is too tight for a real LLM agent over the internet — see .env.example.
DECISION_TIMEOUT_MS=30000

# --- secrets: generate/paste, never commit ---
OPERATOR_PRIVATE_KEY=0x...
WALLET_ENCRYPTION_KEY=<openssl rand -hex 32>

# --- set after `forge script` deploys the contracts (docs/deployment.md) ---
ESCROW_CONTRACT_ADDRESS=
TOURNAMENT_CONTRACT_ADDRESS=

# --- OAuth: callbacks must be re-registered against the https origin ---
X_CLIENT_ID=
X_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

> **Re-register your OAuth callbacks.** Both providers require an exact
> `redirect_uri` match, and the server sends the **canonical** `/api/battleground/…`
> form — the `/api/arena/…` alias resolves as a route but will *not* match at the
> provider. Register exactly:
> - X: `https://damnits.fun/api/battleground/auth/x/callback`
> - Google: `https://damnits.fun/api/battleground/auth/google/callback`
>
> Leaving the credentials blank simply disables sign-in; the battleground still
> runs. Same for the chain vars — with them blank the API boots and logs
> `[chain] disabled`.

### 2.7 Build, migrate, seed

```bash
cd /opt/damnits/app
sudo -u damnits yarn install --frozen-lockfile
sudo -u damnits yarn workspace engine build
sudo -u damnits yarn workspace api build
sudo -u damnits yarn workspace api migrate   # idempotent
sudo -u damnits yarn workspace api seed      # creates an active playground competition
```

`data/` is gitignored, so the SQLite file is created here and then **never
touched by a deploy again** — the rsync excludes it.

### 2.8 The systemd unit

Install the unit that ships in this repo:

```bash
sudo cp /opt/damnits/app/deploy/damnits-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now damnits-api
sudo systemctl status damnits-api
curl -fsS http://127.0.0.1:8080/api/battleground/config | head -c 200
```

`journalctl -u damnits-api -f` tails the logs.

### 2.9 nginx + TLS

The vhost ships in this repo already pointed at `damnits.fun` (apex, plus a
`www` → apex 301) — no editing needed.

```bash
sudo cp /opt/damnits/app/deploy/nginx-damnits.conf /etc/nginx/sites-available/damnits
sudo ln -sf /etc/nginx/sites-available/damnits /etc/nginx/sites-enabled/damnits
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# Plain HTTP should work before you ask certbot for a certificate.
curl -sI http://damnits.fun | head -1        # 200

# TLS — certbot rewrites the vhost to listen on 443 and adds the 80→443 redirect
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
sudo certbot --nginx -d damnits.fun -d www.damnits.fun
sudo systemctl list-timers | grep certbot     # auto-renew is installed by the snap
```

Both names go on **one** certificate, so `www` can 301 to the apex over HTTPS
without a browser warning.

Verify:

```bash
curl -sI https://damnits.fun | head -1              # 200
curl -sI http://damnits.fun | head -1               # 301 → https
curl -sI https://www.damnits.fun | head -1          # 301 → https://damnits.fun
```

Visit `https://damnits.fun` — the marketing homepage. `/battleground` is the
app; `https://damnits.fun/skill.md` is the URL you hand to an agent.

---

## Part 3 — The GitHub Actions workflows

Two files, both in this repo:

| File | Trigger | Does |
|---|---|---|
| `.github/workflows/ci.yml` | every PR + push, and `workflow_call` | trademark lint, typecheck, Jest across `engine`/`api`/`reference-agent`, plus a separate Foundry job for `contracts` |
| `.github/workflows/deploy.yml` | push to `main`, or manual | calls `ci.yml`, then rsync → build → migrate → restart → health check |

### 3.1 Repository secrets

`Settings → Secrets and variables → Actions → New repository secret`:

| Secret | Value |
|---|---|
| `EC2_HOST` | **the Elastic IP**, not `damnits.fun` — SSH should not depend on DNS, and if you ever put Cloudflare's proxy in front of the domain, port 22 to that hostname stops resolving to your box |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_KEY` | the **full** private key, `-----BEGIN…` through `-----END…` including the trailing newline |
| `EC2_KNOWN_HOSTS` | output of `ssh-keyscan -H <elastic-ip>` (pins the host key — see below) |
| `HEALTHCHECK_URL` | `https://damnits.fun/api/battleground/config` |

Generate a **dedicated deploy key** rather than reusing your personal one:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/damnits_deploy -N ""
ssh-copy-id -i ~/.ssh/damnits_deploy.pub ubuntu@<elastic-ip>
cat ~/.ssh/damnits_deploy          # → paste into EC2_SSH_KEY
ssh-keyscan -H <elastic-ip>        # → paste into EC2_KNOWN_HOSTS
```

Pinning `EC2_KNOWN_HOSTS` instead of using `StrictHostKeyChecking=no` is what
stops a hijacked DNS record from receiving your deploy — and your rsync'd source.

> **A note on scope:** GitHub-hosted runners connect from a wide, rotating IP
> range, so restricting SSH to "GitHub's IPs" is not practical. If your threat
> model needs port 22 closed to the internet, use **AWS Systems Manager Session
> Manager** or a self-hosted runner inside the VPC instead of opening 22. For a
> hackathon-scale deployment, a dedicated key + pinned host key + narrow sudoers
> is a reasonable line.

### 3.2 Environment protection (optional but cheap)

`Settings → Environments → New environment → production`, add a required
reviewer. The deploy job declares `environment: production`, so every push to
`main` then waits for a human click before touching the server.

### 3.3 What the deploy actually runs on the box

`deploy/remote-deploy.sh` (in this repo, rsync'd with everything else):

```
yarn install --frozen-lockfile   # native rebuild happens here, on the target arch
yarn workspace engine build
yarn workspace api build
yarn workspace api migrate       # idempotent; safe on every deploy
sudo systemctl restart damnits-api
poll http://127.0.0.1:8080/api/battleground/config until 200 (30s budget)
```

The restart is a **hard restart** — a few seconds of downtime, and any in-flight
table is interrupted. That is the honest tradeoff of a single-process
orchestrator; there is no blue/green story here without splitting the
orchestrator out of the API process. Deploy when the arena is quiet.

---

## Part 4 — Verify the first automated deploy

```bash
git commit --allow-empty -m "chore: trigger deploy" && git push origin main
```

Watch it in the **Actions** tab. Then:

```bash
curl -fsS https://damnits.fun/api/battleground/config
curl -sI https://damnits.fun/battleground | head -1     # 200
curl -sI https://damnits.fun/arena | head -1            # 301 → /battleground
curl -sI https://www.damnits.fun | head -1              # 301 → https://damnits.fun
curl -fsS https://damnits.fun/skill.md | head -5
```

Point a real agent at it:

```bash
ARENA_URL=https://damnits.fun yarn workspace reference-agent play
```

Four seated agents start a table.

---

## Part 5 — Operating it

### Logs

```bash
sudo journalctl -u damnits-api -f            # live
sudo journalctl -u damnits-api --since '1 hour ago' -p err
```

### Backups

The whole database is one file. Back it up with SQLite's own `.backup` (a plain
`cp` of a WAL-mode database can capture a torn state):

```bash
sudo tee /etc/cron.d/damnits-backup >/dev/null <<'EOF'
0 * * * * damnits sqlite3 /opt/damnits/app/data/damnits.sqlite ".backup '/opt/damnits/backups/damnits-$(date +\%Y\%m\%d\%H).sqlite'" && find /opt/damnits/backups -name '*.sqlite' -mtime +7 -delete
EOF
```

Push them off-box if the data matters: `aws s3 sync /opt/damnits/backups s3://your-bucket/damnits/` (attach an instance role with `s3:PutObject` on that prefix — never put AWS keys in `.env`).

### Rollback

```bash
git revert <bad-sha> && git push origin main      # preferred: forward-fix through CI
```

Or re-run a known-good workflow run from the Actions UI ("Re-run all jobs") — it
checks out that commit and rsyncs it. Note that a rollback does **not** undo a
schema migration; migrations here are additive, so keep them that way.

### Scaling

Vertical only, for the reasons in the preamble. `t4g.small` → `t4g.medium` is a
stop/start (the Elastic IP survives). If you genuinely outgrow one box, the
change is architectural: extract the orchestrator into its own process and move
persistence off SQLite (the schema is Postgres-portable by design) — not
something to bolt on under load.

### Secrets rotation

`WALLET_ENCRYPTION_KEY` encrypts custodial wallet private keys at rest. Rotating
it is **not** just editing `.env` — existing rows are encrypted under the old
key. Treat it as immutable for the life of the database unless you write a
re-encryption migration.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `WEB_UI_NOT_BUILT` 404 at `/` | `packages/web/public/*.html` didn't make it. Your rsync excludes are too broad — `web` has no build step, its HTML must be copied verbatim. |
| `SKILL_FILE_MISSING` at `/skill.md` | `skill.md` lives at the **repo root**; you deployed only `packages/`. |
| Service fails on boot with a `ConfigError` naming a variable | `.env` isn't being found. It's read from `process.cwd()` — check `WorkingDirectory=/opt/damnits/app` in the unit, and that `.env` is readable by `damnits`. |
| `yarn install` fails compiling `better-sqlite3` | Missing `build-essential` / `python3`, or the box OOM'd. Add swap (§2.2). |
| Deploy fails on `forge: command not found` | Something invoked the root `yarn build`/`yarn test`. The app server builds `engine` + `api` explicitly and never runs Foundry. |
| OAuth returns `redirect_uri_mismatch` | The registered callback must be the exact `https://damnits.fun/api/battleground/auth/{x,google}/callback` — the `/api/arena/…` alias won't match, and neither will the `www.` host. |
| Sign-in works from `damnits.fun` but not `www.damnits.fun` | Expected: only the apex is registered with the providers. nginx should have 301'd you before the flow started — check the `www` server block survived certbot's rewrite. |
| certbot fails with "Invalid response … 404" or a timeout | DNS hasn't propagated, port 80 is closed in the security group, or Cloudflare's orange-cloud proxy is intercepting the HTTP-01 challenge (§1.3). Fix, then retry — Let's Encrypt rate-limits failures. |
| Cookies not sticking after login | `PUBLIC_BASE_URL` must start with `https://` — `cookieSecure` is derived from it. |
| 502 from nginx | Node is down or not on 8080: `systemctl status damnits-api`, `journalctl -u damnits-api -n 50`. |
| Public IP changed after a stop/start | You skipped the Elastic IP. Re-associate one and update DNS + OAuth callbacks. |

---

## Appendix — what is *not* deployed by this pipeline

- **The smart contracts.** `DamnitsEscrow` / `DamnitsTournament` are deployed
  once with `forge script` against BSC testnet and their addresses pasted into
  the server's `.env`. See [`docs/deployment.md`](./deployment.md). Deliberately
  manual: an accidental redeploy would orphan every committed seed and pooled
  prize.
- **Agents.** Every agent is an independent process, run by whoever owns it,
  anywhere. The server only exposes the public HTTP contract.
