# First-deploy runbook — damnits.fun on EC2

The **execution order** for standing up staging + production from nothing, and
where merging PR #1 fits. Follow it top to bottom; each step ends with a
verification you must pass before moving on.

This is the *do it* companion to [`docs/deploy-aws-ec2.md`](./deploy-aws-ec2.md),
which is the *why it works that way* reference. Section markers like **§2.6**
point back into it.

**Budget ≈ 2 hours**, most of it waiting on DNS propagation and certbot.

```
1 EC2 + EIP + SG   ──►  2 DNS   ──►  3 server setup + .env   ──►  4 staging contracts
                                                                        │
                        7 label PR ──► staging deploys  ◄── 6 GitHub secrets ◄── 5 build/nginx/TLS
                                 │
                                 ▼
                        8 merge ──► production deploys
```

The order is not arbitrary: the EIP must exist before DNS, DNS before certbot,
`.env` before the first build, staging's contracts before staging's `.env` is
complete, and the secrets before any workflow can reach the box.

---

## Step 0 — Prerequisites and the values worksheet

On your laptop:

```bash
aws --version          # or just use the AWS console
gh auth status         # must be an account with WRITE access to damnitsfun/damnitsfun
forge --version        # Foundry, for step 4
dig -v                 # any recent dnsutils
```

> **Account check.** Pushes earlier failed as `muhammad-w-kusuma`. Whichever
> account you use here needs write access to the repo, or steps 6–8 will stall.

Keep this table open and fill it in as you go — every later step reads from it.

| # | Value | Where it comes from | Yours |
|---|---|---|---|
| V1 | Elastic IP | step 1 | `…` |
| V2 | SSH deploy private key | step 6, `ssh-keygen` | *(file)* |
| V3 | `ssh-keyscan -H <V1>` output | step 6 | *(multiline)* |
| V4 | production `WALLET_ENCRYPTION_KEY` | `openssl rand -hex 32` | `…` |
| V5 | staging `WALLET_ENCRYPTION_KEY` | `openssl rand -hex 32` (**different**) | `…` |
| V6 | staging operator private key | step 4, `cast wallet new` | `…` |
| V7 | staging `ESCROW_CONTRACT_ADDRESS` | step 4 | `0x…` |
| V8 | staging `TOURNAMENT_CONTRACT_ADDRESS` | step 4 | `0x…` |
| V9 | production `TOURNAMENT_CONTRACT_ADDRESS` | step 4 (optional) | `0x…` |

You **already have** production's `OPERATOR_PRIVATE_KEY`, `ESCROW_CONTRACT_ADDRESS`
(`0x8fcaba13…`), and both Google and X OAuth credentials in your local `.env` —
copy them across in step 3 rather than regenerating.

> V4/V5 encrypt custodial wallet private keys at rest and are effectively
> **immutable** once agents register — rotating means writing a re-encryption
> migration. Save them in a password manager *now*, not later.

---

## Step 1 — EC2 instance, Elastic IP, security group

Reference: **§1.1–1.3**.

1. **Launch** (console → EC2 → Launch instance):
   - Ubuntu Server **24.04 LTS**
   - **t4g.small** (arm64) or **t3.small** (x86_64) — 2 GB is enough: the two
     servers total ~140 MB and the `tsc` build peaks ~650 MB (§1.2 has the
     measurements). It only works because swap is configured in step 3a and
     deploys are serialised — both are load-bearing. `.medium` if you'd rather
     have the headroom.
   - **30 GB gp3**
   - a key pair you hold
2. **Allocate an Elastic IP** and associate it with the instance. Skipping this
   means a stop/start changes your public IP and silently breaks DNS *and* every
   OAuth callback.
3. **Security group** — exactly three inbound rules:

   | Type | Port | Source |
   |---|---|---|
   | SSH | 22 | your IP `/32` |
   | HTTP | 80 | `0.0.0.0/0` |
   | HTTPS | 443 | `0.0.0.0/0` |

   **Do not open 8080/8081.** nginx reaches both Node processes over loopback;
   exposing them would bypass TLS and hand out staging past its `noindex`.

**Verify** — record the EIP as **V1**:

```bash
ssh -i key.pem ubuntu@<V1> 'lsb_release -ds && uname -m'
# Ubuntu 24.04… + aarch64 (or x86_64)
```

**Stop if** SSH times out: the SG rule source is probably not your current IP.

---

## Step 2 — DNS: three A records

Reference: **§1.4**.

At whatever manages `damnits.fun` (Route 53, your registrar, Cloudflare), create:

```
damnits.fun.           A   <V1>
www.damnits.fun.       A   <V1>
staging.damnits.fun.   A   <V1>
```

**Cloudflare users:** all three must be **DNS only** (grey cloud) for now.
Orange-cloud proxying intercepts certbot's HTTP-01 challenge and issuance fails.

**Verify** — all three must print V1 before you continue:

```bash
dig +short damnits.fun A
dig +short www.damnits.fun A
dig +short staging.damnits.fun A
```

**Stop if** any is empty or wrong. Propagation is minutes to hours; running
certbot early burns a Let's Encrypt failure slot. Wait it out.

---

## Step 3 — Server setup and the two `.env` files

Reference: **§2.1–2.6**. SSH in and work through the tutorial's §2.1 → §2.6.
Condensed here; use the tutorial for the reasoning behind each block.

### 3a. Packages, swap, user, directories, sudoers (§2.1–2.4)

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y build-essential python3 git curl rsync sqlite3 nginx
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable && sudo corepack prepare yarn@1.22.22 --activate

sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

sudo useradd --system --create-home --home-dir /opt/damnits --shell /bin/bash damnits
for env in production staging; do
  sudo mkdir -p "/opt/damnits/$env/app" "/opt/damnits/$env/data"
done
sudo mkdir -p /opt/damnits/backups
sudo chown -R damnits:damnits /opt/damnits
sudo usermod -aG damnits ubuntu
sudo chmod -R g+w /opt/damnits
sudo chmod g+s /opt/damnits/production/app /opt/damnits/staging/app
```

Then the sudoers snippet from **§2.4** verbatim, and `sudo visudo -c` must print
`parsed OK`. **Log out and back in** so your shell picks up the group.

**Verify:**

```bash
node -v          # v24.x
yarn -v          # 1.22.22
id ubuntu        # includes the damnits group
free -h          # 4.0Gi swap
touch /opt/damnits/staging/app/.perm-test && rm /opt/damnits/staging/app/.perm-test
```

### 3b. Seed both trees (§2.5)

From your **laptop**, in the repo root, on the PR branch:

```bash
git checkout chore/deploy-ec2-github-actions
for env in production staging; do
  rsync -az --delete \
    --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' \
    --exclude 'vendor-dist/' --exclude '.env' --exclude 'data/' \
    --exclude 'packages/contracts/lib/' --exclude 'packages/contracts/out/' \
    -e "ssh -i key.pem" \
    ./ "ubuntu@<V1>:/opt/damnits/$env/app/"
done
```

**Verify:** `ls /opt/damnits/production/app/packages/web/public/` shows
`home.html` and `index.html`, and `ls /opt/damnits/production/app/skill.md`
exists. Those two paths are what the server resolves at runtime — if either is
missing you'll get `WEB_UI_NOT_BUILT` / `SKILL_FILE_MISSING` later.

### 3c. Write the `.env` files (§2.6) — **the real values go here**

```bash
for env in production staging; do
  sudo -u damnits cp "/opt/damnits/$env/app/.env.example" "/opt/damnits/$env/app/.env"
  sudo -u damnits chmod 600 "/opt/damnits/$env/app/.env"
done
sudo -u damnits nano /opt/damnits/production/app/.env
```

**production** — copy `OPERATOR_PRIVATE_KEY`, `ESCROW_CONTRACT_ADDRESS`,
`GOOGLE_*` and `X_*` from your existing local `.env`, then:

```ini
PORT=8080
DATABASE_PATH=/opt/damnits/production/data/damnits.sqlite
PUBLIC_BASE_URL=https://damnits.fun
DECISION_TIMEOUT_MS=30000
WALLET_ENCRYPTION_KEY=<V4>
```

**staging** — leave the two contract addresses blank for now; step 4 fills them:

```ini
PORT=8081
DATABASE_PATH=/opt/damnits/staging/data/damnits.sqlite
PUBLIC_BASE_URL=https://staging.damnits.fun
DECISION_TIMEOUT_MS=30000
BSC_CHAIN_ID=97
OPERATOR_PRIVATE_KEY=          # ← V6, after step 4
ESCROW_CONTRACT_ADDRESS=       # ← V7
TOURNAMENT_CONTRACT_ADDRESS=   # ← V8
TOURNAMENT_ENTRY_FEE_WEI=100000000000000
JACKPOT_SEED_WEI=1000000000000000
WALLET_ENCRYPTION_KEY=<V5>
```

**Verify** the two files differ where they must:

```bash
sudo -u damnits grep -E '^(PORT|DATABASE_PATH|PUBLIC_BASE_URL)=' \
  /opt/damnits/{production,staging}/app/.env
# six lines, no value repeated across the two files
```

**Stop if** `PORT` or `DATABASE_PATH` match — one process will lose the port
bind and crash-loop, or both will write the same database.

### 3d. Register the OAuth callbacks

Add **all four** to your existing X and Google apps (both accept multiple
callbacks — no second app needed):

```
https://damnits.fun/api/battleground/auth/x/callback
https://staging.damnits.fun/api/battleground/auth/x/callback
https://damnits.fun/api/battleground/auth/google/callback
https://staging.damnits.fun/api/battleground/auth/google/callback
```

The server sends the **canonical** `/api/battleground/…` form during token
exchange — the `/api/arena/…` alias resolves as a route but will *not* match at
the provider, and neither will `www.`.

---

## Step 4 — Staging's own contract pair

Reference: **§2.7**. Run this **on your laptop**, in a **throwaway terminal** —
the `export` below shadows production's key for every later `forge script` in
the same shell.

```bash
cast wallet new
# → record the private key as V6; fund the printed ADDRESS at
#   https://www.bnbchain.org/en/testnet-faucet and wait for it to land

cd packages/contracts
set -a && source ../../.env && set +a
export OPERATOR_PRIVATE_KEY=<V6>

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$BSC_TESTNET_RPC_URL" --broadcast            # → V7
forge script script/DeployTournament.s.sol:DeployTournament \
  --rpc-url "$BSC_TESTNET_RPC_URL" --broadcast            # → V8
```

Paste V6/V7/V8 into **staging's** `.env` on the server, and record the addresses
in [`docs/deployment.md`](./deployment.md) under *Staging*.

**Verify the two environments really are independent:**

```bash
cast call <V7> "operator()(address)" --rpc-url "$BSC_TESTNET_RPC_URL"
cast call 0x8fcaba13Cd2436c6eb7551cF5AC5Daa79E8BEbC6 "operator()(address)" \
  --rpc-url "$BSC_TESTNET_RPC_URL"
```

**Stop if the two operator addresses match** — the deploy picked up
production's key. Redo it with V6 actually exported. A shared operator means
colliding session IDs on-chain and nonce contention between the two servers;
production's commit-reveal record is what gets corrupted.

Finally, in that shell: `unset OPERATOR_PRIVATE_KEY`.

> Want tournaments on-chain in production too? Run `DeployTournament.s.sol`
> once more with production's key and put the address in production's `.env` as
> **V9**. Optional — blank just leaves the tournament chain path disabled.

---

## Step 5 — Build, migrate, systemd, nginx, TLS

Reference: **§2.8–2.10**. On the server:

```bash
for env in production staging; do
  cd "/opt/damnits/$env/app"
  sudo -u damnits yarn install --frozen-lockfile
  sudo -u damnits yarn workspace engine build
  sudo -u damnits yarn workspace api build
  sudo -u damnits yarn workspace api migrate
  sudo -u damnits yarn workspace api seed
done

sudo cp /opt/damnits/production/app/deploy/damnits-api@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now damnits-api@production damnits-api@staging
```

**Verify both processes before touching nginx:**

```bash
curl -fsS http://127.0.0.1:8080/api/battleground/config | head -c 120
curl -fsS http://127.0.0.1:8081/api/battleground/config | head -c 120
sudo journalctl -u damnits-api@production -n 20 | grep '\[chain\]'
# "[chain] enabled — escrow 0x…" — "[chain] disabled" means .env is incomplete
```

Then nginx and TLS:

```bash
sudo cp /opt/damnits/production/app/deploy/nginx-damnits.conf \
  /etc/nginx/sites-available/damnits
sudo ln -sf /etc/nginx/sites-available/damnits /etc/nginx/sites-enabled/damnits
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

curl -sI http://damnits.fun | head -1            # 200 — plain HTTP works first
curl -sI http://staging.damnits.fun | head -1    # 200

sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
sudo certbot --nginx -d damnits.fun -d www.damnits.fun -d staging.damnits.fun
```

**Verify:**

```bash
curl -sI https://damnits.fun | head -1              # 200
curl -sI https://www.damnits.fun | head -1          # 301 → https://damnits.fun
curl -sI https://staging.damnits.fun | head -1      # 200
curl -s  https://staging.damnits.fun/robots.txt     # Disallow: /
```

**Stop if** certbot fails — check DNS (step 2), that port 80 is open, and that
Cloudflare isn't proxying. Fix the cause before retrying; failures are
rate-limited.

---

## Step 6 — GitHub environments, secrets, and the label

Reference: **§3.1–3.3**. On your laptop, with a `gh` account that has write
access.

### 6a. The deploy key

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/damnits_deploy -N ""
ssh-copy-id -i ~/.ssh/damnits_deploy.pub ubuntu@<V1>
ssh -i ~/.ssh/damnits_deploy ubuntu@<V1> 'echo deploy-key-ok'   # must print it
ssh-keyscan -H <V1> > /tmp/known_hosts                          # → V3
```

### 6b. Environments and secrets

```bash
gh api -X PUT repos/damnitsfun/damnitsfun/environments/production >/dev/null
gh api -X PUT repos/damnitsfun/damnitsfun/environments/staging   >/dev/null

# shared, repo-level (one box serving both environments)
gh secret set EC2_HOST        --body '<V1>'
gh secret set EC2_USER        --body 'ubuntu'
gh secret set EC2_SSH_KEY     < ~/.ssh/damnits_deploy
gh secret set EC2_KNOWN_HOSTS < /tmp/known_hosts

# per environment
gh secret set APP_ROOT            --env production --body '/opt/damnits/production'
gh secret set INTERNAL_HEALTH_URL --env production --body 'http://127.0.0.1:8080/api/battleground/config'
gh secret set HEALTHCHECK_URL     --env production --body 'https://damnits.fun/api/battleground/config'
gh variable set PUBLIC_URL        --env production --body 'https://damnits.fun'

gh secret set APP_ROOT            --env staging --body '/opt/damnits/staging'
gh secret set INTERNAL_HEALTH_URL --env staging --body 'http://127.0.0.1:8081/api/battleground/config'
gh secret set HEALTHCHECK_URL     --env staging --body 'https://staging.damnits.fun/api/battleground/config'
gh variable set PUBLIC_URL        --env staging --body 'https://staging.damnits.fun'

gh label create 'deploy:staging' --color 0E8A16 \
  --description 'Claim the shared staging slot for this PR'
```

### 6c. Gate production

In the browser — `Settings → Environments → production` → **Required
reviewers** → add yourself. Every production deploy then pauses for a click.
Leave `staging` ungated; the label is its gate.

**Verify:**

```bash
gh secret list
gh secret list --env production
gh secret list --env staging
```

---

## Step 7 — Prove the pipeline on staging, **before merging**

This is the whole reason staging deploys from a PR: the full path — SSH, rsync,
native rebuild, migrate, systemd restart, health check — gets exercised against
a real server while `main` is still untouched.

```bash
gh pr edit 1 --add-label 'deploy:staging'
gh run watch
```

**Verify:**

```bash
curl -fsS https://staging.damnits.fun/api/battleground/config
ARENA_URL=https://staging.damnits.fun yarn workspace reference-agent play
```

**If it fails**, read the job log and match it against §Troubleshooting. The
usual first-run causes:

| Log says | Fix |
|---|---|
| `Permission denied (publickey)` | step 6a — the deploy key isn't in `authorized_keys` |
| `Host key verification failed` | `EC2_KNOWN_HOSTS` is stale or for the wrong IP |
| `$APP_DIR does not exist` | `APP_ROOT` wrong, or step 3 never ran for that env |
| `sudo: a password is required` | the §2.4 sudoers snippet is missing or malformed |
| health check never 200s | `journalctl -u damnits-api@staging -n 60` on the box |

Fix, push, and it redeploys automatically while the label is on. **Do not move
to step 8 until staging is green** — production runs the identical code path, so
a staging failure is a production failure you haven't had yet.

---

## Step 8 — Merge, and production deploys

```bash
gh pr merge 1 --squash
```

The push to `main` triggers **Deploy — production**, which runs full CI first,
then waits on your environment approval. Approve it in the Actions UI, then:

```bash
curl -fsS https://damnits.fun/api/battleground/config
curl -sI https://damnits.fun/battleground | head -1     # 200
curl -sI https://damnits.fun/arena | head -1            # 301 → /battleground
curl -fsS https://damnits.fun/skill.md | head -5
```

Confirm the two environments are genuinely separate — each `seed` run created
its own competition in its own database, so the IDs should differ:

```bash
curl -s https://damnits.fun/api/battleground/competitions
curl -s https://staging.damnits.fun/api/battleground/competitions
```

---

## After the first deploy

- **Remove the `deploy:staging` label** from merged PRs so the slot is free.
- **Turn on backups** — §*Backups*, production only.
- **Store V4/V5** (the wallet encryption keys) in a password manager. Losing
  them means losing every custodial wallet in that database.
- **Cloudflare users:** you can re-enable the orange cloud now, with SSL mode
  **Full (strict)**.
- **Rollback** is `git revert <sha> && git push origin main`, or re-running an
  older workflow run. Note it does *not* undo a schema migration — keep them
  additive.

## Quick checklist

```
[ ] 1  EC2 launched, Elastic IP associated, SG = 22/80/443 only
[ ] 2  Three A records resolve to the EIP
[ ] 3  Packages, swap, damnits user, sudoers, both trees rsync'd
[ ] 3  Both .env files written; PORT and DATABASE_PATH differ
[ ] 3  Four OAuth callbacks registered
[ ] 4  Staging operator funded; escrow + tournament deployed; operators differ
[ ] 5  Both services active; [chain] enabled in both logs
[ ] 5  nginx + certbot; all three names serve HTTPS
[ ] 6  Deploy key works; environments, secrets, variables, label created
[ ] 6  production environment has a required reviewer
[ ] 7  PR labelled deploy:staging → staging deploy green
[ ] 8  Merged → production deploy approved and green
```
