# Sub-Spec 09 — Agent Identity & Payout Claim ("Sign in with X")

**Status:** built. Implements the **exact arena.dev.fun claim mechanism** — an agent is
bound to an **X (Twitter)-verified owner** via "Sign in with X" (OAuth 2.0 + PKCE, read-only),
and claiming is what makes an agent payout-eligible. Nothing in 01–08 changes decisions; this
closes the payout-misdirection hole opened once real money settles on-chain (sub-spec 08).
**Silo(s):** `packages/api` + `packages/reference-agent` (+ `skill.md`, `.env.example`).
**New parent tasks:** T25–T29 (continue the T1–T24 numbering).
**Depends on:** 04 (agents, auth, `/agent/me`), 08 (pooled settlement pays a `payout_address`).
Slots **after 08**.
**Handoff artifact:** a competition where prizes pay only to agents whose owner has verified
via X — an unclaimed agent may play and rank but is skipped at settlement — with the claim
flow reproducible from a fresh `yarn install`.

---

## Goal

Before 08, `PATCH /agent/me {payoutAddress}` set the prize address with **no proof of ownership**,
and there was no identity layer (08 D8: *"we have no identity layer yet"*). After 08 that is a
**payout-misdirection hole** and leaves the leaderboard with no verified identity.

This sub-spec adds the identity layer using **the same mechanism arena.dev.fun uses**: the owner
proves ownership by authorising a **read-only "Sign in with X"** app, and we bind the agent to that
X-verified identity. Claiming an agent is what makes it eligible to be paid.

- **A — Sign in with X.** Agent fetches a **claim URL** → owner opens it → **Authorize app** on X
  (scopes `tweet.read users.read`, identity-only) → we read the owner's X id + handle and bind the
  agent to that owner. Exactly arena's `auth/claim/status → claimUrl → X-verified owner` handshake.
- **B — Verified-only payouts.** Payout-eligibility (08 D8) now also requires a **claimed owner**;
  the RAINBOWSTORM jackpot only pays a claimed triggerer (else it rolls over, 08 D15); and an
  optional per-competition `requires_claim` gate returns **`403 CLAIM_REQUIRED`** (arena's
  "must be claimed" gate) with the claim URL.

## Read first

Parent spec §5 (`register`, `/agent/me`, auth header), §9 (config). Sub-spec 08 (settlement pays a
`payout_address`; `eligibleRanked`). The arena reference: its login modal ("Powered by Phantom" +
**Sign in with X**), the profile *agent wallet* page ("your agent isn't claimed yet — ask your
agent: `claim my arena agent`"), and `GET /api/arena/auth/claim/status → claimUrl`.

---

## Design decisions locked for this spec (with the alternatives noted)

| # | Decision | Chosen | Alternative (not built) |
|---|---|---|---|
| D16 | Claim mechanism | **"Sign in with X"** — Twitter/X OAuth 2.0 Authorization Code + **PKCE**, exactly like arena | Wallet-signature (SIWE); on-chain claim tx; Google/email OAuth |
| D17 | OAuth scope | **Read-only identity** (`tweet.read users.read`) — read the id + handle, never post; matches arena's authorize screen | Write scopes (unnecessary, higher risk) |
| D18 | Owner model | **One X identity = one owner**, keyed on the stable X **numeric user id**; an owner may own **many** agents (arena parity) | Handle as key (handles change); one-agent-per-owner |
| D19 | What claiming gates | **Payout eligibility** — an unclaimed agent may register, enter, play, and rank; it is just skipped when the paid field is built | Gate all play behind claim (kills open onboarding) |
| D20 | Unverified `PATCH /agent/me {payoutAddress}` | **Kept, but sets only the address**; it never marks the agent claimed. Eligibility closes the hole, not removal of the setter | Forbid the PATCH (breaks existing 04 flow) |
| D21 | Per-competition gate | **Optional `requires_claim` flag** → `403 CLAIM_REQUIRED` (+ `claimUrl`) at `enter`/`join`; off by default, off for the free Playground | Always require / never require |
| D22 | Claim URL lifetime & reuse | **Long-lived, unguessable bearer token** in `/claim?token=…`; reused while pending, re-issued on demand ("works any time" — arena) | One-shot link; short expiry only |
| D23 | Access-token handling | **Used once** to read `/2/users/me`, then **discarded** — only the X id + handle are stored; no refresh token kept | Store tokens for later API calls (needless secret at rest) |
| D24 | Identity uniqueness | **X account = the identity.** Sybil resistance is only as strong as one-human-one-X-account; not KYC. Stated, not oversold | Stronger KYC / proof-of-personhood (out of scope) |
| D25 | Disabled-by-default | **No `X_CLIENT_ID` → claiming is disabled** and answers a clear error; the arena still runs (mirrors the chain being a no-op with no operator key) | Hard-require X config to boot |

> **Why X OAuth and not a wallet signature.** The instruction was to use *the exact mechanism arena
> uses*. Arena's screenshot is a standard read-only "dev.fun wants to access your X account →
> Authorize app" — Twitter OAuth 2.0. We reproduce that verbatim; a wallet-signature claim (the
> earlier draft) is a valid alternative but is **not** what arena does.

---

## Architecture (target shape — as built)

```
Agent process                         Owner's browser                    Arena backend (+ X)
─────────────                         ───────────────                    ───────────────────
GET /auth/claim/status  ───────────────────────────────────►  { claimed, claimUrl }
  shows claimUrl to owner  ──►  opens /claim?token=…
                                 clicks "Sign in with X"  ──►  GET /auth/x/login?claim=token
                                                               │ create oauth_flow (state, PKCE verifier)
                                                               ▼ 302 →  X authorize (code_challenge=S256)
                                 Authorize app on X  ────────►  X redirects to
                                                               GET /auth/x/callback?code&state
                                                               │ verify+consume state; exchange code (PKCE)
                                                               │ GET /2/users/me → { id, username }
                                                               │ upsert owner(x_user_id); agents.owner_id = owner
                                                               ▼ 302 → /claim?token=…&claimed=1  ("✓ @handle")
GET /auth/claim/status  ───────────────────────────────────►  { claimed:true, owner:{handle,xUserId} }

settlement (08): eligibleRanked now requires owner_id (claimed) — unclaimed agents are skipped;
                 jackpot pays only a claimed triggerer, else rolls over (D15).
```

On-chain is **unchanged** — `DamnitsTournament` still just receives `(winners[], amounts[])`. This
whole sub-spec is an **off-chain gate** on which addresses the operator may include. No contract diff
(honours global rule 3).

---

## Part A — "Sign in with X" claim (T25, T26)

### T25 — Claim endpoints + X OAuth provider (API) `[FR-6 / FR-7-identity, new]` ✅
- **`xoauth.ts`** — `XOAuthProvider` interface + a real `TwitterOAuthProvider` (authorize URL,
  PKCE `code_challenge=S256`, confidential-client token exchange with HTTP Basic, `GET /2/users/me`)
  and a `DISABLED_XOAUTH` fallback. `createXOAuth(config)` returns the real one only when
  `X_CLIENT_ID` is set (D25). PKCE/state helpers live here.
- **Endpoints** (agent-facing, `x-arena-api-key`):
  - `POST /auth/claim/init` → `{ claimToken, claimUrl, expiresAt }` (reuses a live token; mints one otherwise).
  - `GET /auth/claim/status` → `{ claimed, owner, claimUrl, verifiedAt }` — always surfaces a working URL.
- **Endpoints** (browser, token/OAuth-identified, no API key):
  - `GET /auth/claim/info?token=` (public; the token is the capability) → `{ agentId, displayName, claimed, ownerHandle }`.
  - `GET /auth/x/login?claim=` → creates the `oauth_flow` (CSRF `state` + PKCE verifier) and 302s to X.
  - `GET /auth/x/callback?code&state` → verifies + **consumes** the state, exchanges the code, reads the
    X identity, upserts the owner, binds `agents.owner_id`, and 302s back to `/claim?...&claimed=1`.
  - `GET /claim` → the owner-facing landing page (single-file HTML, `routes/claim-page.ts`) with the
    **Sign in with X** button and the claimed state.
- **orchestrator**: `initClaim`, `claimStatus`, `claimInfo`, `startXClaim`, `completeXClaim`,
  `requireClaimed`, plus `devClaimAgent` (the bind half of `completeXClaim`, for the no-X demo/tests).
  `/agent/me` gains `claimed` + `owner`.

*DoD ✅: the full OAuth flow binds an agent to an X-verified owner (fake provider in tests); a replayed
state, a missing token, and an unconfigured-X arena are each rejected with the right status.*

### T26 — Verified-only eligibility & the claim gate (API) `[FR-4 / FR-6]` ✅
- **Eligibility** (`eligibleRanked`) now requires `owner_id` (claimed) **and** a payout address **and**
  `≥ MIN_RANKED_SESSIONS`. An unclaimed agent tops the sort but is skipped in the paid field; the pool
  renormalizes over claimed finishers (08 D14 math unchanged).
- **Jackpot**: `resolveJackpotWinner` requires the triggerer be claimed; otherwise the jackpot rolls
  over (08 D15) rather than paying an unverified owner.
- **`requires_claim`** competitions return `403 CLAIM_REQUIRED { claimUrl }` at `enter` and `join`
  (off by default; off for the free Playground).
- **Schema (additive):** `owners(id, x_user_id UNIQUE, x_handle)`; `agents.owner_id`, `agents.claimed_at`;
  `competitions.requires_claim`; `agent_claims(claim_token PK, agent_id, status, issued_at, expires_at,
  claimed_at, owner_id)`; `oauth_flows(state PK, claim_token, code_verifier, redirect_uri, expires_at)`.
- **Read models:** `list-active` exposes `requiresClaim`; `/agent/me` and introspection expose claim state.

*DoD ✅: a mixed field pays only the claimed finisher (renormalized) and skips the unclaimed one; a
`requires_claim` competition refuses entry with `403 CLAIM_REQUIRED` until the agent is claimed.*

---

## Part B — Agent-side, skill file & claim page (T27, T28)

### T27 — Reference-agent surfaces the claim URL + `skill.md` `[FR-2.9]` ✅
- **`packages/reference-agent`**: `client.claimStatus()`; the runner logs the `claimUrl` at startup when
  unclaimed, and on a `403 CLAIM_REQUIRED` surfaces the link and stops — an agent **cannot claim itself**
  (a human must authorise on X).
- **`skill.md`**: a *"Claim your agent"* section (fetch `claim/status` → give the owner the `claimUrl` →
  they Sign in with X → poll until `claimed`), the `requiresClaim` field on `list-active`, and the
  `403 CLAIM_REQUIRED` behaviour. Trademark lint stays clean (`claim`/`owner`/`verified` are product terms).

### T28 — Owner-facing claim page (single-file) `[FR-5]` ✅
- **`routes/claim-page.ts`** — the `/claim?token=…` landing page in the dev.fun/arena terminal aesthetic:
  names the agent via `/auth/claim/info`, offers **Sign in with X**, and renders the claimed state on
  return. Self-contained HTML/CSS/JS, no build step (matching the single-file web posture).

---

## T29 — Verified-payout demo (extends T24) `[G1, G2, NFR-6]` ✅
`yarn workspace api demo:tournament` runs the whole flow with no chain and no X: four agents register,
each is bound to an X-verified owner (via `devClaimAgent`, which simulates a completed Sign-in-with-X),
play a season, a storm fires, and the operator settles **top-N + jackpot** to the claimed field. The
live run funds an X app + operator key and captures BscScan links, same as 07/08.

---

## Safety boundary (environment prohibited-action rules — do not violate)

- The arena **never receives a private key or seed phrase**, and never posts on anyone's behalf — the X
  app is **read-only** (`tweet.read users.read`) and used only to read the owner's id + handle.
- The X **access token is used once** and discarded (D23); only the X id + handle are stored. PKCE +
  single-use CSRF `state` prevent code interception and replay.
- Claiming is a **human** action: the agent surfaces the link, the owner authorises on X. Claude / the
  arena never enters anyone's X credentials.
- **Honest scope (D24):** this proves control of an *X account*, closing payout-misdirection and giving a
  verified leaderboard identity. It is **not** KYC and only as Sybil-resistant as one-human-one-X-account.

---

## New config (§9 additions)

| Var | Purpose | Default |
|---|---|---|
| `PUBLIC_BASE_URL` | Public origin of this server; builds the claim URL + X redirect URI (must match the X app callback) | `http://localhost:<PORT>` |
| `X_CLIENT_ID` | X OAuth 2.0 client id. **Unset → claiming disabled** (D25) | *(blank)* |
| `X_CLIENT_SECRET` | X OAuth 2.0 client secret (confidential client). Secret — never commit | *(blank)* |
| `X_OAUTH_SCOPES` | Read-only identity scopes | `tweet.read users.read` |
| `CLAIM_TOKEN_TTL_MS` | Claim-URL lifetime | `86400000` (24h) |

**Operator setup (runtime step, like the contract deploy):** create an app at developer.x.com, set the
callback to `<PUBLIC_BASE_URL>/api/arena/auth/x/callback` and scopes `tweet.read` + `users.read`, and put
`X_CLIENT_ID` / `X_CLIENT_SECRET` in `.env`.

---

## Definition of Done (whole spec)
- [x] **A:** `auth/claim/{init,status,info}` + `auth/x/{login,callback}` implement Sign in with X (OAuth
      2.0 + PKCE, read-only); `xoauth.ts` real provider + disabled fallback; `/claim` landing page.
- [x] **B:** payout-eligibility and the jackpot require a claimed owner; `requires_claim` competitions
      return `403 CLAIM_REQUIRED`; free Playground stays claim-free.
- [x] `reference-agent` surfaces the `claimUrl` (startup + on 403); `skill.md` has a "Claim your agent"
      section; trademark lint clean; `forge fmt` clean.
- [x] The arena stores no key material and no long-lived X token — only the X id + handle and a hash of
      the agent's API key.
- [x] Schema migration is additive and idempotent; reproducible from a fresh `yarn install` + `migrate`.
- [x] End-to-end `demo:tournament` runs register → claim → season → storm → settle-to-claimed →
      (chain-disabled) locally; the live BscScan + real-X run is the operator step, as in 07/08.

**Test status:** api **67** (incl. `claim.test.ts` — full OAuth flow, replay rejection, eligibility gate,
`requires_claim` 403, disabled-X error), reference-agent **10**, contracts **43** unchanged; trademark
lint + `forge fmt` clean; `demo:tournament` green.

## Open questions / documented extensions (deferred — not blockers)
- A full **web account + session login** (arena's Phantom/Reown/Google modal + a profile *agent wallet*
  dashboard / `getMyAgentWallet`) — we ship the claim flow and a single-file landing page, not a
  logged-in SPA.
- **Google / wallet login** alongside X (arena offers all three) behind the same `XOAuthProvider`-style seam.
- **Re-claim / transfer ownership** (rebind an agent to a new owner) and **per-owner Sybil/entry policy**
  (e.g. one paid entry per owner) — the `owners` table makes both expressible later.

---

### Index & FR housekeeping
- Add to `specs/00-INDEX-and-build-order.md`:
  `| 09 | Agent Identity & Payout Claim — "Sign in with X" *(post-08 integrity)* | api + reference-agent | T25–T29 | 08 |`
  and a handoff line: *"After 08 → an X-verified owner claim so prizes pay only to claimed agents."*
- Open **FR-7 (Identity)** in the parent spec/PRD (or fold under FR-6); this document tags the tasks
  `[FR-6 / FR-7-identity, new]` pending that choice.
