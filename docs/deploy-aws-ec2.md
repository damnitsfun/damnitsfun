# Deploying damnits.fun to AWS EC2 (with GitHub Actions)

A complete, copy-pasteable tutorial for hosting this monorepo on EC2 in **two
environments** — `staging` and `production` — kept current by GitHub Actions.

**What you end up with**

```
                                       ┌─ https://damnits.fun ──────────┐
Browser / agent ──► nginx (TLS) ───────┤                                │
                                       └─ https://staging.damnits.fun ──┘
                          │                              │
              proxy_pass :8080                proxy_pass :8081
                          ▼                              ▼
      damnits-api@production          damnits-api@staging      ← systemd template unit
      /opt/damnits/production/app     /opt/damnits/staging/app
      /opt/damnits/production/data    /opt/damnits/staging/data  ← separate SQLite files
```

Each instance serves the whole product from one process: `/` (homepage),
`/battleground`, `/profile`, `/claim`, `/skill.md`, and `/api/battleground/*`
(plus the deprecated `/api/arena/*` alias).

| | trigger | CI gate | slot |
|---|---|---|---|
| **production** | push to `main` | full suite must pass | dedicated |
| **staging** | PR labelled `deploy:staging` | none — the PR's own CI check covers it | **shared, last-deploy-wins** |

---

## Before you start: four facts about this app that shape the deployment

Read these — they explain *why* the tutorial does things the way it does.

1. **Each environment is one process, and must stay one process.** The
   orchestrator (`packages/api/src/orchestrator.ts`) runs in-process with real
   timers, and persistence is `better-sqlite3` (synchronous, single file). You
   **cannot** run two replicas of an environment behind a load balancer — they
   would both drive the same tables and fight over the same file. Vertical
   scaling only.

2. **This is also why staging is a shared slot, not one environment per PR.**
   There is nothing to spin up per branch — no stateless container to duplicate.
   Two PRs can't both hold staging, so claiming it is an explicit act (the
   `deploy:staging` label) rather than something that happens silently on every
   push.

3. **`better-sqlite3` is a native module, so `node_modules` is not portable.**
   Do not build on the GitHub runner and ship `node_modules`. Both environments
   run `yarn install` *on the instance*, which is why it needs `build-essential`
   and `python3`.

4. **The repo layout must survive the deploy.** `server.ts` resolves the static
   UI and `skill.md` relative to the compiled file:

   ```
   packages/api/dist/../../web/public   →  packages/web/public/{home,index}.html
   packages/api/dist/../../..           →  repo root, for /skill.md
   ```

   So deploy the **whole repo tree**, not just `packages/api`. And `.env` is
   resolved from **`process.cwd()`** (`loadConfig` calls
   `process.loadEnvFile(resolve(process.cwd(), '.env'))`), which is why the unit
   sets `WorkingDirectory` to that environment's repo root.

Also note: the root `yarn build` / `yarn test` scripts fan out to **all**
workspaces, including `contracts`, whose scripts are `forge build` / `forge test`.
Foundry is not installed on the app server and does not need to be — the deploy
builds `engine` and `api` explicitly. Contracts ship separately via `forge
script` (see [`docs/deployment.md`](./deployment.md)).

---

## Part 1 — Provision

### 1.1 One instance or two?

Both environments can share a box, or each can have its own. **The workflows
don't care** — the target is entirely determined by environment-scoped secrets
(`EC2_HOST`, `APP_ROOT`), so you can start on one box and split later without
touching a workflow file.

| | one box | two boxes |
|---|---|---|
| cost | one instance | two |
| isolation | a staging build can OOM the box and take production with it | complete |
| setup | one nginx, one cert, ports 8080/8081 | duplicate Part 2 per box, both on :8080 |

**Recommendation: start with one box.** Split only if staging starts disrupting
production. This tutorial documents the one-box layout and flags the two-box
deltas inline.

### 1.2 Launch

| Setting | Value | Why |
|---|---|---|
| AMI | **Ubuntu Server 24.04 LTS** | Current LTS; NodeSource ships Node 24 for it. |
| Instance type | **t4g.medium** (arm64) or **t3.medium** (x86_64) | 4 GB. Two Node processes plus a `tsc` build across five workspaces will not fit comfortably in 2 GB. A single-environment box can use `.small`. |
| Storage | **30 GB gp3** | Two trees × (repo + `node_modules`), plus SQLite, backups and logs. |
| Key pair | create/choose one | You need SSH for the first-time setup. |
| Elastic IP | **allocate and associate one** | A stopped/started instance changes its public IP otherwise, breaking DNS *and* your OAuth callbacks. |

> Pick **one** architecture and stick with it. `better-sqlite3` publishes
> prebuilt binaries for both `linux-x64` and `linux-arm64`, but if a prebuild is
> missing it compiles from source — that is what `build-essential` is for.

### 1.3 Security group

| Type | Port | Source |
|---|---|---|
| SSH | 22 | **Your IP only** (`x.x.x.x/32`) — not `0.0.0.0/0` |
| HTTP | 80 | `0.0.0.0/0` (certbot's HTTP-01 challenge + the redirect to HTTPS) |
| HTTPS | 443 | `0.0.0.0/0` |

**Do not open 8080 or 8081.** Both Node processes bind `0.0.0.0` and nginx
reaches them over loopback. Opening them would expose each API bypassing TLS —
and would let anyone reach staging directly, past the `noindex` and any basic
auth you add.

### 1.4 DNS for `damnits.fun`

Three `A` records, all pointing at the Elastic IP (or: the staging record at the
second box's EIP, if you split):

```
damnits.fun.           A   <elastic-ip>     # apex — the canonical production origin
www.damnits.fun.       A   <elastic-ip>     # 301'd to the apex by nginx
staging.damnits.fun.   A   <elastic-ip>     # staging
```

The apex **must** be an `A` record — CNAME at the zone apex is invalid, which is
exactly why this setup uses an Elastic IP rather than chasing a changing public
IP.

Where you create them depends on where `damnits.fun` is managed:

- **Route 53** — create a public hosted zone for `damnits.fun`, add the three
  `A` records, then copy the four `NS` values from the zone into your
  registrar's nameserver settings. Propagation is minutes-to-hours.
- **Registrar's own DNS** (Namecheap, Porkbun, Cloudflare, …) — just add the
  three `A` records there. Nothing here needs Route 53.
- **Cloudflare specifically** — set all three to **DNS only** (grey cloud) for
  the initial certbot run. Orange-cloud proxying intercepts the HTTP-01
  challenge and issuance fails. You can re-enable the proxy afterwards, but then
  keep SSL mode on **Full (strict)**.

Confirm before moving on — a wrong answer here wastes a Let's Encrypt
rate-limit slot:

```bash
dig +short damnits.fun A
dig +short www.damnits.fun A
dig +short staging.damnits.fun A     # all three should print your Elastic IP
```

**The apex is canonical for production.** `PUBLIC_BASE_URL=https://damnits.fun`,
the OAuth `redirect_uri` is derived from it, and nginx 301s `www` → apex.

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

Node comes from apt rather than nvm on purpose: systemd needs a stable absolute
path (`/usr/bin/node`), and nvm's shell-function shims are invisible to it.

### 2.2 Swap

Two environments building concurrently can spike well past RAM and get
OOM-killed mid-deploy. Cheap insurance even on a 4 GB box.

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 2.3 Service user and per-environment directories

Don't run the app as `ubuntu`, and don't run it as root. Both environments share
one service user; isolation between them comes from separate directories,
databases, and ports.

```bash
sudo useradd --system --create-home --home-dir /opt/damnits --shell /bin/bash damnits

for env in production staging; do
  sudo mkdir -p "/opt/damnits/$env/app" "/opt/damnits/$env/data"
done
sudo mkdir -p /opt/damnits/backups
sudo chown -R damnits:damnits /opt/damnits
```

Note the shape: **`data/` sits beside `app/`, not inside it.** The deploy's
`rsync --delete` targets `app/` only, so it can never reach a database.

The deploy user (`ubuntu`) needs to rsync into those trees and run commands as
`damnits`:

```bash
sudo usermod -aG damnits ubuntu
sudo chmod -R g+w /opt/damnits
# new files inherit the group, so rsync-created files stay writable by both
sudo chmod g+s /opt/damnits/production/app /opt/damnits/staging/app
```

Log out and back in for the group change to apply to your shell.

### 2.4 Let the deploy restart the services without a password

```bash
sudo tee /etc/sudoers.d/damnits-deploy >/dev/null <<'EOF'
ubuntu ALL=(root) NOPASSWD: /bin/systemctl restart damnits-api@production, /bin/systemctl restart damnits-api@staging
ubuntu ALL=(root) NOPASSWD: /bin/systemctl status damnits-api@production, /bin/systemctl status damnits-api@staging
ubuntu ALL=(root) NOPASSWD: /bin/journalctl -u damnits-api@production *, /bin/journalctl -u damnits-api@staging *
ubuntu ALL=(damnits) NOPASSWD: ALL
EOF
sudo chmod 440 /etc/sudoers.d/damnits-deploy
sudo visudo -c    # must print "parsed OK"
```

Both instances are named explicitly rather than globbed — a `damnits-api@*`
wildcard would grant restart rights over any future instance you add.

### 2.5 Seed both working trees

The first copy comes from your laptop (later ones come from Actions):

```bash
# from your laptop, in the repo root
for env in production staging; do
  rsync -az --delete \
    --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' \
    --exclude 'vendor-dist/' --exclude '.env' --exclude 'data/' \
    --exclude 'packages/contracts/lib/' --exclude 'packages/contracts/out/' \
    -e "ssh -i key.pem" \
    ./ "ubuntu@<elastic-ip>:/opt/damnits/$env/app/"
done
```

### 2.6 Write each environment's `.env`

`.env` is gitignored and **never** travels through CI. It lives on the box only,
and the two files must differ — this is where the environments actually diverge.

```bash
for env in production staging; do
  sudo -u damnits cp "/opt/damnits/$env/app/.env.example" "/opt/damnits/$env/app/.env"
  sudo -u damnits chmod 600 "/opt/damnits/$env/app/.env"
done
sudo -u damnits nano /opt/damnits/production/app/.env
sudo -u damnits nano /opt/damnits/staging/app/.env
```

**production** — `/opt/damnits/production/app/.env`:

```ini
PORT=8080
DATABASE_PATH=/opt/damnits/production/data/damnits.sqlite
PUBLIC_BASE_URL=https://damnits.fun

# 3s is too tight for a real LLM agent over the internet — see .env.example.
DECISION_TIMEOUT_MS=30000

OPERATOR_PRIVATE_KEY=0x...
WALLET_ENCRYPTION_KEY=<openssl rand -hex 32>
ESCROW_CONTRACT_ADDRESS=
TOURNAMENT_CONTRACT_ADDRESS=

X_CLIENT_ID=
X_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

**staging** — `/opt/damnits/staging/app/.env`. Same chain (BNB testnet, ID 97),
**its own contracts and its own operator key**:

```ini
PORT=8081
DATABASE_PATH=/opt/damnits/staging/data/damnits.sqlite
PUBLIC_BASE_URL=https://staging.damnits.fun
DECISION_TIMEOUT_MS=30000

# Same network as production — this is a testnet, staging belongs on it.
BSC_TESTNET_RPC_URL=https://bsc-testnet-dataseed.bnbchain.org
BSC_CHAIN_ID=97

# A SECOND operator key, and the contracts IT deployed. Never production's —
# see the warning below. Fund it from the faucet like any other.
OPERATOR_PRIVATE_KEY=0x<staging operator key>
ESCROW_CONTRACT_ADDRESS=0x<staging escrow, from §2.7>
TOURNAMENT_CONTRACT_ADDRESS=0x<staging tournament, from §2.7>

# Keep staging's on-chain money small — it is spent on every test run.
TOURNAMENT_ENTRY_FEE_WEI=100000000000000    # 0.0001 tBNB
JACKPOT_SEED_WEI=1000000000000000           # 0.001 tBNB
PLAYGROUND_JACKPOT_SEED_WEI=1000000000000000

# Its OWN key. Sharing production's would let a staging database decrypt
# production's custodial wallets.
WALLET_ENCRYPTION_KEY=<a different openssl rand -hex 32>

# Same OAuth apps, different registered callback (see below).
X_CLIENT_ID=
X_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

> ### ⚠ Staging shares the chain, never the contracts or the operator key
>
> Both environments live on BNB testnet 97. What must **not** be shared is the
> `ESCROW_CONTRACT_ADDRESS` / `TOURNAMENT_CONTRACT_ADDRESS` pair or the
> `OPERATOR_PRIVATE_KEY`. Two independent reasons, either one sufficient:
>
> 1. **Session IDs are allocated per database.** Point both at one escrow and
>    staging will call `openSession` / `commitSeed` with IDs that collide with
>    production's — overwriting or reverting against production's commit-reveal
>    record. That record is the fairness guarantee; a collision makes production
>    matches unverifiable.
> 2. **One key signing from two processes means nonce contention.** Each
>    instance builds transactions from its own view of the operator's nonce.
>    Concurrent settlements produce `replacement transaction underpriced` /
>    `nonce too low` failures — and the loser is whichever settlement happened
>    to be production's.
>
> Fund the staging operator from the same faucet
> (<https://www.bnbchain.org/en/testnet-faucet>) and keep its entry fees and
> jackpot seeds small, since every test run spends them.

> ### Re-register the OAuth callbacks
>
> Both providers require an exact `redirect_uri` match, and the server sends the
> **canonical** `/api/battleground/…` form — the `/api/arena/…` alias resolves as
> a route but will *not* match at the provider. Register **both** URLs (X and
> Google each accept multiple callbacks on one app):
>
> - `https://damnits.fun/api/battleground/auth/x/callback`
> - `https://staging.damnits.fun/api/battleground/auth/x/callback`
> - `https://damnits.fun/api/battleground/auth/google/callback`
> - `https://staging.damnits.fun/api/battleground/auth/google/callback`
>
> Leaving the credentials blank simply disables sign-in; the battleground still
> runs.

### 2.7 Deploy staging's own contract set

Do this **from your laptop**, not the server — Foundry is a build tool and the
app server never needs it. You already have the toolchain from
[`docs/deployment.md`](./deployment.md).

```bash
# 1. A second throwaway operator key, distinct from production's
cast wallet new
# → fund the printed address at https://www.bnbchain.org/en/testnet-faucet

# 2. Deploy both contracts under THAT key. The scripts read OPERATOR_PRIVATE_KEY
#    from the environment and make the deployer the operator, so overriding it
#    for the command is all that is needed — production's .env is untouched.
cd packages/contracts
set -a && source ../../.env && set +a
export OPERATOR_PRIVATE_KEY=0x<staging operator key>

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BSC_TESTNET_RPC_URL" --broadcast
forge script script/DeployTournament.s.sol:DeployTournament \
  --rpc-url "$BSC_TESTNET_RPC_URL" --broadcast
```

Copy the two printed addresses into **staging's** `.env` (§2.6), and record them
in [`docs/deployment.md`](./deployment.md) alongside production's so it stays
obvious which address belongs to which environment.

> `export` in a shell you also use for production work is a foot-gun — that
> variable now shadows production's key for every later `forge script` in the
> same session. Run this in a throwaway terminal, or `unset
> OPERATOR_PRIVATE_KEY` when you're done.

Verify the two sets really are distinct before moving on:

```bash
cast call <staging-escrow> "operator()(address)" --rpc-url "$BSC_TESTNET_RPC_URL"
cast call <production-escrow> "operator()(address)" --rpc-url "$BSC_TESTNET_RPC_URL"
# two different addresses, or something is wired wrong
```

### 2.8 Build, migrate, seed

```bash
for env in production staging; do
  cd "/opt/damnits/$env/app"
  sudo -u damnits yarn install --frozen-lockfile
  sudo -u damnits yarn workspace engine build
  sudo -u damnits yarn workspace api build
  sudo -u damnits yarn workspace api migrate   # idempotent
  sudo -u damnits yarn workspace api seed      # creates an active playground competition
done
```

Each environment's SQLite file is created here and then **never touched by a
deploy again**.

### 2.9 The systemd template unit

One template file, two instances — `%i` expands to the environment name.

```bash
sudo cp /opt/damnits/production/app/deploy/damnits-api@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now damnits-api@production
sudo systemctl enable --now damnits-api@staging

systemctl status 'damnits-api@*'
curl -fsS http://127.0.0.1:8080/api/battleground/config | head -c 120   # production
curl -fsS http://127.0.0.1:8081/api/battleground/config | head -c 120   # staging
```

Logs, per environment:

```bash
sudo journalctl -u damnits-api@production -f
sudo journalctl -u damnits-api@staging -f
```

### 2.10 nginx + TLS

The vhost ships in this repo already configured for all three names — no editing
needed.

```bash
sudo cp /opt/damnits/production/app/deploy/nginx-damnits.conf /etc/nginx/sites-available/damnits
sudo ln -sf /etc/nginx/sites-available/damnits /etc/nginx/sites-enabled/damnits
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# Plain HTTP should work before you ask certbot for a certificate.
curl -sI http://damnits.fun | head -1            # 200
curl -sI http://staging.damnits.fun | head -1    # 200

sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
sudo certbot --nginx -d damnits.fun -d www.damnits.fun -d staging.damnits.fun
sudo systemctl list-timers | grep certbot     # auto-renew is installed by the snap
```

All three names go on **one** certificate. Verify:

```bash
curl -sI https://damnits.fun | head -1              # 200
curl -sI http://damnits.fun | head -1               # 301 → https
curl -sI https://www.damnits.fun | head -1          # 301 → https://damnits.fun
curl -sI https://staging.damnits.fun | head -1      # 200
curl -s  https://staging.damnits.fun/robots.txt     # Disallow: /
```

---

## Part 3 — The GitHub Actions workflows

Four files, all in this repo:

| File | Trigger | Does |
|---|---|---|
| `ci.yml` | every PR + push, and `workflow_call` | trademark lint, typecheck, Jest across `engine`/`api`/`reference-agent`, a 10× real-delay soak, plus a Foundry job |
| `deploy-target.yml` | `workflow_call` only | **the single deploy implementation** — rsync → build → migrate → restart → health check |
| `deploy.yml` | push to `main`, or manual | calls `deploy-target` with `environment: production`, CI gate on |
| `deploy-staging.yml` | PR labelled `deploy:staging`, or manual | calls `deploy-target` with `environment: staging`, CI gate off |

The deploy logic exists **once**. Staging and production differ only in which
environment's secrets get resolved — which is also why moving staging to its own
EC2 instance later is a secrets change, not a code change.

### 3.1 Create the environments

`Settings → Environments → New environment` — create **`production`** and
**`staging`**.

On `production`, add yourself as a **required reviewer**. Every push to `main`
then pauses for a human click before touching the live site. (Leave `staging`
ungated; the label already is the gate.)

### 3.2 Secrets

Some are shared, some must be per-environment. Repository-level secrets are
visible to both environments; an environment-level secret of the same name wins.

**Repository secrets** (`Settings → Secrets and variables → Actions`) — shared,
assuming one box:

| Secret | Value |
|---|---|
| `EC2_HOST` | the **Elastic IP**, not `damnits.fun` — SSH shouldn't depend on DNS, and a Cloudflare proxy in front of the domain would break it |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_KEY` | the **full** private key, `-----BEGIN…` through `-----END…`, trailing newline included |
| `EC2_KNOWN_HOSTS` | output of `ssh-keyscan -H <elastic-ip>` |

**Environment secrets** — one set each:

| Secret | `production` | `staging` |
|---|---|---|
| `APP_ROOT` | `/opt/damnits/production` | `/opt/damnits/staging` |
| `INTERNAL_HEALTH_URL` | `http://127.0.0.1:8080/api/battleground/config` | `http://127.0.0.1:8081/api/battleground/config` |
| `HEALTHCHECK_URL` | `https://damnits.fun/api/battleground/config` | `https://staging.damnits.fun/api/battleground/config` |

**Environment variables** (the *Variables* tab, not Secrets) — these show up as
the deployment URL in the Actions UI:

| Variable | `production` | `staging` |
|---|---|---|
| `PUBLIC_URL` | `https://damnits.fun` | `https://staging.damnits.fun` |

> **Two boxes instead of one?** Move `EC2_HOST` (and `EC2_KNOWN_HOSTS`, and the
> key if it differs) from repository-level down into each environment, and set
> both `APP_ROOT`s to `/opt/damnits/production` on their own hosts. Nothing else
> changes.

Generate a **dedicated deploy key** rather than reusing your personal one:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/damnits_deploy -N ""
ssh-copy-id -i ~/.ssh/damnits_deploy.pub ubuntu@<elastic-ip>
cat ~/.ssh/damnits_deploy          # → EC2_SSH_KEY
ssh-keyscan -H <elastic-ip>        # → EC2_KNOWN_HOSTS
```

Pinning `EC2_KNOWN_HOSTS` instead of `StrictHostKeyChecking=no` is what stops a
hijacked DNS record from receiving your deploy — and your source tree.

> **A note on scope:** GitHub-hosted runners connect from a wide, rotating IP
> range, so restricting SSH to "GitHub's IPs" isn't practical. If your threat
> model needs port 22 closed to the internet, use **AWS Systems Manager Session
> Manager** or a self-hosted runner inside the VPC. For a hackathon-scale
> deployment, a dedicated key + pinned host key + narrow sudoers is a reasonable
> line.

### 3.3 Create the staging label

```bash
gh label create 'deploy:staging' --color 0E8A16 \
  --description 'Claim the shared staging slot for this PR'
```

Add it to a PR → staging deploys that PR's merge commit. Push more commits →
it redeploys automatically (the `synchronize` trigger) as long as the label is
still on. Remove the label → it stops redeploying, but staging keeps serving
whatever was last pushed to it; the next labelled PR takes the slot.

### 3.4 What runs on the box

`deploy/remote-deploy.sh`, with `ENV_NAME` and `APP_ROOT` passed over SSH:

```
yarn install --frozen-lockfile   # native rebuild happens here, on the target arch
yarn workspace engine build
yarn workspace api build
yarn workspace api migrate       # idempotent; safe on every deploy
sudo systemctl restart damnits-api@<env>
poll the loopback health URL until 200 (30s budget)
```

The restart is a **hard restart** — a few seconds of downtime, and any in-flight
table is interrupted. That's the honest tradeoff of a single-process
orchestrator; there's no blue/green story without splitting the orchestrator out
of the API process. Deploy production when the arena is quiet — that's what the
required reviewer on the environment is for.

---

## Part 4 — Verify

### Staging first

```bash
git checkout -b test/staging-smoke
git commit --allow-empty -m "chore: smoke-test staging"
git push -u origin test/staging-smoke
gh pr create --fill
gh pr edit --add-label 'deploy:staging'
```

Watch **Actions**, then:

```bash
curl -fsS https://staging.damnits.fun/api/battleground/config
curl -sI https://staging.damnits.fun/battleground | head -1     # 200
ARENA_URL=https://staging.damnits.fun yarn workspace reference-agent play
```

### Then production

Merge to `main`, approve the environment gate, and:

```bash
curl -fsS https://damnits.fun/api/battleground/config
curl -sI https://damnits.fun/battleground | head -1     # 200
curl -sI https://damnits.fun/arena | head -1            # 301 → /battleground
curl -sI https://www.damnits.fun | head -1              # 301 → https://damnits.fun
curl -fsS https://damnits.fun/skill.md | head -5
```

Confirm the two really are separate — each `seed` run created its own
competition in its own database, so the IDs should not match:

```bash
curl -s https://damnits.fun/api/battleground/competitions
curl -s https://staging.damnits.fun/api/battleground/competitions
```

---

## Part 5 — Operating it

### Logs

```bash
sudo journalctl -u damnits-api@production -f
sudo journalctl -u damnits-api@staging --since '1 hour ago' -p err
```

### Backups — production only

The whole database is one file. Back it up with SQLite's own `.backup`; a plain
`cp` of a WAL-mode database can capture a torn state.

```bash
sudo tee /etc/cron.d/damnits-backup >/dev/null <<'EOF'
0 * * * * damnits sqlite3 /opt/damnits/production/data/damnits.sqlite ".backup '/opt/damnits/backups/damnits-$(date +\%Y\%m\%d\%H).sqlite'" && find /opt/damnits/backups -name '*.sqlite' -mtime +7 -delete
EOF
```

Push them off-box if the data matters: `aws s3 sync /opt/damnits/backups
s3://your-bucket/damnits/` (attach an instance role with `s3:PutObject` on that
prefix — never put AWS keys in `.env`).

### Refreshing staging from production

Useful before testing a migration against realistic data:

```bash
sudo systemctl stop damnits-api@staging
sudo -u damnits sqlite3 /opt/damnits/production/data/damnits.sqlite \
  ".backup '/opt/damnits/staging/data/damnits.sqlite'"
sudo systemctl start damnits-api@staging
```

Two things to know before you do:

- The copied rows include **custodial wallet keys encrypted under production's
  `WALLET_ENCRYPTION_KEY`**, which staging can't decrypt — expect wallet
  operations to fail there. That is the correct and safe outcome; don't "fix" it
  by copying the production key over.
- The copy also carries production's **session and competition rows**, including
  ones production already committed and settled against *its* escrow. Staging's
  escrow has never seen those IDs, so anything mid-flight in the copy will fail
  to settle on staging. Refresh from a quiet moment, and treat the copy as
  read-mostly test data rather than a resumable state.

### Rollback

```bash
git revert <bad-sha> && git push origin main      # preferred: forward-fix through CI
```

Or re-run a known-good workflow run from the Actions UI — it checks out that
commit and rsyncs it. A rollback does **not** undo a schema migration;
migrations here are additive, so keep them that way.

### Scaling

Vertical only, for the reasons in the preamble. `t4g.medium` → `t4g.large` is a
stop/start (the Elastic IP survives). If you genuinely outgrow one box, the
change is architectural: extract the orchestrator into its own process and move
persistence off SQLite (the schema is Postgres-portable by design) — not
something to bolt on under load.

### Secrets rotation

`WALLET_ENCRYPTION_KEY` encrypts custodial wallet private keys at rest. Rotating
it is **not** just editing `.env` — existing rows are encrypted under the old
key. Treat it as immutable for the life of a database unless you write a
re-encryption migration. Back it up somewhere durable.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Staging deploy job never starts | The `deploy:staging` label isn't on the PR, or the PR is from a fork (refused by design — deploying means running that PR's install scripts on your box). Check the `gate` job's notice. |
| Staging shows someone else's branch | Working as designed — it's a shared, last-deploy-wins slot. Re-push or re-add the label to reclaim it. |
| A deploy fails with `$APP_DIR does not exist` | That environment's Part 2 setup was never run, or `APP_ROOT` is wrong in the environment secrets. |
| `WEB_UI_NOT_BUILT` 404 at `/` | `packages/web/public/*.html` didn't make it. Your rsync excludes are too broad — `web` has no build step, its HTML must be copied verbatim. |
| `SKILL_FILE_MISSING` at `/skill.md` | `skill.md` lives at the **repo root**; you deployed only `packages/`. |
| Service fails on boot with a `ConfigError` naming a variable | `.env` isn't being found. It's read from `process.cwd()` — check `WorkingDirectory=/opt/damnits/%i/app` and that `.env` is readable by `damnits`. |
| Both environments serve identical data | They're sharing a `DATABASE_PATH`. Each `.env` must point at its own `/opt/damnits/<env>/data/damnits.sqlite`. |
| Staging starts, production dies (or vice versa) | Same `PORT` in both `.env` files — one process wins the bind, the other crash-loops. Production 8080, staging 8081. |
| `yarn install` fails compiling `better-sqlite3` | Missing `build-essential` / `python3`, or the box OOM'd. Add swap (§2.2). |
| Deploy fails on `forge: command not found` | Something invoked the root `yarn build`/`yarn test`. The app server builds `engine` + `api` explicitly and never runs Foundry. |
| OAuth returns `redirect_uri_mismatch` | Register the exact `https://<host>/api/battleground/auth/{x,google}/callback` for **both** hosts — the `/api/arena/…` alias won't match, and neither will `www.`. |
| Cookies not sticking after login | `PUBLIC_BASE_URL` must start with `https://` — `cookieSecure` is derived from it. |
| 502 from nginx | That environment's Node process is down: `systemctl status damnits-api@staging`, `journalctl -u damnits-api@staging -n 50`. |
| certbot fails with "Invalid response … 404" or a timeout | DNS hasn't propagated, port 80 is closed, or Cloudflare's orange-cloud proxy is intercepting the challenge (§1.4). Fix, then retry — Let's Encrypt rate-limits failures. |
| Public IP changed after a stop/start | You skipped the Elastic IP. Re-associate one and update DNS + OAuth callbacks. |
| `replacement transaction underpriced` / `nonce too low` in the chain log | Both environments are signing with the **same** `OPERATOR_PRIVATE_KEY`. Each instance tracks the nonce independently, so they collide. Give staging its own key (§2.6/§2.7). |
| Staging logs `NotOperator` on commit or settle | Staging's `.env` points at production's contract addresses, whose operator is production's key. Both addresses must be the pair staging deployed. |
| Staging settlement reverts with an unknown session | Its database was copied from production (see *Refreshing staging*) and references sessions staging's escrow never opened. Expected — start from a quiet copy. |
| Either environment logs `[chain] disabled` unexpectedly | That `.env` is missing `OPERATOR_PRIVATE_KEY` or `ESCROW_CONTRACT_ADDRESS`. The API runs fine without them; it just won't touch the chain. |

---

## Appendix — what is *not* deployed by this pipeline

- **The smart contracts.** Each environment gets its **own** `DamnitsEscrow` +
  `DamnitsTournament` pair on BNB testnet 97, deployed once with `forge script`
  under that environment's operator key and pasted into that environment's
  `.env` (§2.7). See [`docs/deployment.md`](./deployment.md) for the address
  record. Deliberately manual and outside CI: an accidental redeploy would
  orphan every committed seed and pooled prize on that environment.
- **Agents.** Every agent is an independent process, run by whoever owns it,
  anywhere. The server only exposes the public HTTP contract.
