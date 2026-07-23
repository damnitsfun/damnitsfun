# Sub-Spec 11 — Homepage & Web Accounts (Google sign-in, X-mapped profile, claim-link agents)

**Status:** draft (for review — not yet built). Adds the two things arena.dev.fun has but damnits does
not yet: a **marketing homepage** that is the product's front door (like `dev.fun/`), with the spectator
**arena moved to `/arena` as "the app"**; and a **web account** that follows arena's exact mechanism —

- **sign up / sign in with Google** (the browser login),
- **connect X** on your profile — the X account **maps** the web account to a public, anti-Sybil identity,
- **claim an agent** to your account via a **claim link** the agent gives you (`/claim/<token>`), under
  arena's rule: **each X account can claim one agent; each agent can be claimed once.**

**Silo(s):** `packages/web` (homepage + arena UI + profile) + `packages/api` (Google web session + reusing 09's X + claim).
**New parent tasks:** T34–T38 (continue the T1–T33 numbering).
**Depends on:** 09 (X OAuth provider, `owners` table, `agents.owner_id`, the agent claim-token flow), 10 (arena tabs/IA), 06 (single-file web posture).
Slots **after 10**.
**Handoff artifact:** a homepage at `/` routing into the arena at `/arena`; a person who can **sign in
with Google**, land on a **profile** (`/profile/<id>`), **connect X**, then **claim one agent** via its
claim link — with the one-agent-per-X / one-claim-per-agent rule enforced — and sign out. Reproducible
from a fresh `yarn install` (+ a Google app and the 09 X app).

> **The parts are independent.** Part A (homepage) touches no auth; Part B (accounts) touches no
> marketing page. Split into separate specs when implementing if you prefer; kept together here because
> they are one product ask ("the front door and the account layer") and share the arena header.

---

## Goal

Today the whole site **is** the arena, served at `/`. There is **no homepage** and **no web account**.
09 shipped the *agent claim* mechanism (an agent mints a claim link; the owner opens it and Signs in
with X; the agent binds to that X owner) and a `/claim` page — but a **person** cannot sign in, and
there is no profile. This sub-spec adds both, following arena's model exactly (see the profile
screenshots):

- **Google = the web account.** A human signs up / signs in with Google → a browser session. The
  profile lives at **`/profile/<accountId>`** ("owner profile", a display name — default "Unnamed
  User" — a "member since" date, and an avatar). *New — 09 has no Google.*
- **Connect X = map the account to a public identity.** The profile has a **[ connect X ]** action:
  authorising X (09's Sign-in-with-X, `xoauth.ts`, unchanged) links the account to an X identity. This
  is the public, anti-Sybil anchor and the gate for claiming.
- **Claim an agent = arena's claim-link flow.** Under **AGENTS · LINKED ARENA IDENTITIES**, an account
  with no agents shows *"read `…/skills/arena.md` … to create or link an arena agent"* and an
  **[ claim your agent ]** button. Claiming: *ask your agent for a claim link → open it (e.g.
  `/claim/devfun-J965-ELE2`) → follow the process*. The agent maps to the account, enforcing the arena
  rule: **each X account can only claim one agent; each agent can only be claimed once.**

Everything reuses 09 (the X provider, `owners`, the agent-minted claim token) and adds a Google session
+ an `accounts` layer + the 1:1 constraint. No on-chain or agent-API change.

## Read first

Sub-spec 09 (X OAuth 2.0 + PKCE `xoauth.ts`; `/auth/x/{login,callback}`; `owners(x_user_id, x_handle)`;
`agents.owner_id`, `claimed_at`; agent-minted claim token via `/auth/claim/init`; `/claim` page;
`/agent/me`, `/agent/wallet`). Sub-spec 10 (arena tabs; single-file `index.html`; hero). Parent §5, §9.
The arena reference: `dev.fun/` (homepage) vs `arena.dev.fun` (app); the **`/profile/<id>`** page
(owner profile · member since · **connect X** · AGENTS/linked identities · **claim your agent** modal:
*"Each X account can only claim one agent. Each agent can only be claimed once."*).

---

## Design decisions locked for this spec (with the alternatives noted)

| # | Decision | Chosen | Alternative (not built) |
|---|---|---|---|
| D33 | Homepage vs app split | **Path-based on one server**: `/` = homepage, **`/arena`** = the app. dev.fun uses subdomains; we have one Fastify origin + a no-build frontend. | Subdomains; keep the app at `/` (no front door) |
| D34 | Homepage build | **A second single-file page** `home.html` (no build step), arena's aesthetic. | A framework/SSG |
| D35 | Web sign-up / sign-in | **Google OAuth 2.0 + PKCE** (`GoogleOAuthProvider`) — the **web account is a Google identity** (stable `sub` + email). Profile at `/profile/<accountId>`. | X-as-web-login; email+password |
| D36 | Connect X (identity mapping) | **"connect X"** from the profile — 09's Sign-in-with-X, unchanged — **maps the account to an X identity** (`accounts.owner_id` → 09's `owners`). The public, anti-Sybil anchor; **required before claiming**. | Google-only identity (no public handle / weak Sybil); wallet mapping |
| D37 | Claim an agent | **Arena's claim-link flow** (09's agent-minted token): the agent gives a link `/claim/<token>`; a **logged-in, X-connected** account opens it and follows the process → the agent maps to the account. | A dashboard "add agent by id" (no proof the caller controls the agent) |
| D38 | Claim constraints | **1:1, arena parity**: **each connected X can claim at most one agent; each agent can be claimed once.** This **refines 09 D18** (which allowed many agents per owner) down to arena's one-per-X. | Many agents per X (09 D18 as-is) |
| D39 | Two providers, two jobs | **Google = login; X = the public identity + the claim gate.** | One provider for both |
| D40 | Session storage | **Server-side `web_sessions`** — opaque token in an **httpOnly, SameSite=Lax, Secure-in-prod** cookie; revocable; bound to the **account**. | JWT/localStorage |
| D41 | Data model (additive to 09) | New **`accounts`** (Google) + **`accounts.owner_id`** → 09's `owners`(X); 09's `owners` and `agents.owner_id` **reused unchanged**, plus a **uniqueness guard** so an owner has ≤1 claimed agent (D38). | Migrate `owners`→`accounts` (disruptive to a built 09) |
| D42 | Login is optional | **Spectating stays 100% anonymous** (10's replay feed). An account only unlocks the profile + claiming. | Gate the arena behind login |
| D43 | Disabled-by-default | **No `GOOGLE_CLIENT_ID` → web login disabled**; **no `X_CLIENT_ID` → connect-X/claim disabled** (09 D25). The arena still runs. | Hard-require either app to boot |

> **Why Google for login, X for identity + claim.** A person shouldn't need a public X handle just to
> sign in and watch — Google is the frictionless door. But payouts and the leaderboard need a public,
> hard-to-Sybil identity, so the account **connects X**, and that X is what gates claiming (one X → one
> agent). The agent itself proves control by minting the claim link (09). Wallet login stays deferred.

---

## Architecture (target shape)

```
BEFORE                                   AFTER
──────                                    ─────
GET /            → the arena (app)        GET /            → homepage (home.html)          [Part A]
                                          GET /arena       → the arena app (index.html)

(no web account)                          Arena header:  logged out → [ sign in with Google ]   [Part B]
                                                          logged in  → [ name ▾ ] → /profile/<id>
                                          GET  /auth/google/login    ─► Google authorize (PKCE)
                                          GET  /auth/google/callback ─► upsert accounts(google_sub),
                                              open web_sessions, Set-Cookie sid; 302 → /arena
                                          GET  /auth/session → { account, x|null, agents[] } | 401
                                          POST /auth/logout  → revoke

                                          Profile /profile/<id>:                            [Part B]
                                            [ connect X ] → /auth/x/login?mode=connect (09 provider)
                                                callback → upsert owners(x_user_id) [09],
                                                           accounts.owner_id = owner   (maps account ↔ X)
                                            AGENTS · LINKED IDENTITIES:
                                              [ claim your agent ] → modal:
                                                 "ask your agent for a claim link → open /claim/<token>"
                                            open /claim/<token> while logged-in + X-connected:
                                                 bind agent→owner (09), IF owner has no agent yet AND
                                                 agent unclaimed  → else 409  (1:1, D38)
```

Two OAuth providers, two jobs. **Google** authenticates the account; **X** (09, verbatim) maps it to a
public identity and gates claiming. 09's claim-token flow, `owners`, `agents.owner_id`, and all on-chain
settlement are unchanged except for the **one-agent-per-owner** guard (D38).

---

## Part A — Marketing homepage & the `/arena` split (T34)

### T34 — Homepage `home.html`; move the app to `/arena` `[FR-5, new]`
- **`packages/web/public/home.html`** — a single-file marketing page (arena aesthetic, reuse CSS
  tokens). Sections adapting `dev.fun/` to damnits/UNO: **top nav** (brand · `[arena] [how it works]
  [rules]` · a right-aligned **sign in with Google**); **hero** (*"The arena for agents."* / *"the arena
  is open. build an AI. take a seat."* / **→ enter the arena** → `/arena`); **the game**; **live
  preview** (teaser → `/arena`, `<iframe src="/arena">` acceptable); **how to join** (read `skill.md` →
  register → sign in with Google, connect X, claim → play); **on-chain & fair** (commit-reveal /
  BSC-testnet); **prize/tournament** (optional, 08); **FAQ** + **footer**.
- **`server.ts`** — `GET /` → `home.html`; **`GET /arena`** → `index.html`. Keep `/skill.md`, `/claim`,
  `/api/arena/*` as-is. The arena `API` base (`location.origin + '/api/arena'`) is unaffected.
- **Arena → home** — a "← damnits.fun" brand link in the arena header pointing to `/`.

*DoD: `/` shows the homepage; "enter the arena" loads `/arena` (app unchanged); `skill.md`/`/claim`/API
routes still resolve; both pages single-file, no build step.*

---

## Part B — Web accounts: Google login · connect X · claim-link agents · profile (T35–T38)

### T35 — Google web session (API) `[FR-7-identity, new]`
- **`googleoauth.ts`** — a `GoogleOAuthProvider` mirroring `xoauth.ts` (authorize URL, PKCE `S256`,
  token exchange, `GET userinfo`), scopes **`openid email profile`**, and a `DISABLED_GOOGLE` fallback;
  real only when `GOOGLE_CLIENT_ID` is set (D43).
- **Endpoints:** `GET /auth/google/login` (mints `oauth_flows` `purpose='google'`, 302 → Google);
  `GET /auth/google/callback` (verify+consume `state`, exchange code, read `{ sub, email, name }`,
  **upsert `accounts`**, open `web_sessions`, `Set-Cookie sid` httpOnly/SameSite=Lax/Secure-in-prod,
  302 → `/arena`); `GET /auth/session` → `{ account:{ id, email, name, memberSince }, x:{ handle,
  xUserId } | null, agents:[…] } | 401`; `POST /auth/logout` → revoke + clear cookie.
- **Schema (additive):** `accounts(id, google_sub UNIQUE, email, name, owner_id NULL→owners, created_at)`;
  `web_sessions(token PK, account_id, created_at, expires_at)`; `oauth_flows.purpose`
  (`'claim' | 'google' | 'connect'`, default `'claim'`).

*DoD: a Google round-trip (fake provider) upserts an account, sets a session cookie, and `/auth/session`
returns the account (`x:null`, no agents); replayed `state` / missing-expired cookie / unconfigured-Google
handled; `logout` revokes.*

### T36 — Connect X + claim an agent, with the 1:1 rule (API, reuses 09) `[FR-6]`
- **Connect X** — `GET /auth/x/login?mode=connect` (requires the `sid` cookie) → 09's `xoauth.ts`
  unchanged; callback (`purpose='connect'`) upserts 09's `owners` and sets **`accounts.owner_id`**
  (maps account ↔ X). One X maps to one account (unique `owner_id` across accounts).
- **Claim an agent** — the agent still mints a claim link via 09 (`/auth/claim/init` → `/claim/<token>`).
  Opening `/claim/<token>` **while logged in with a connected X** binds the agent to the account's owner
  (09's `agents.owner_id`), **gated by D38**:
  - reject (`409 ALREADY_CLAIMED`) if the agent is already claimed;
  - reject (`409 X_ALREADY_HAS_AGENT`) if the owner (X) already has a claimed agent;
  - require an X-connected account (`403 CONNECT_X_FIRST`) — the claim needs the anti-Sybil anchor.
  09's original `/claim?token=…` + Sign-in-with-X path still works for the no-web-account case, subject
  to the same 1:1 guard.
- **Reuse** `/agent/me`, `/agent/wallet` (09) to read agent state + balance for the profile.

*DoD: a logged-in account connects X (fake provider) → `/auth/session` returns `x:{handle}`; it then
claims one agent via its link and the agent appears under the account; a **second** claim by the same X
is rejected 409; claiming an **already-claimed** agent is rejected 409; a claim without a connected X is
rejected 403; 09's standalone tests still pass.*

### T37 — Profile page + arena header auth (web) `[FR-5]`
- **`/profile/<accountId>`** — a page (single-file, or a section in `index.html`) matching arena:
  "owner profile" + **EDIT** (rename display name via `PATCH /auth/account`), avatar, name (default
  "Unnamed User"), "member since"; a **[ connect X ]** button (or the `@handle` once connected); an
  **AGENTS · LINKED ARENA IDENTITIES · N DEPLOYED** section listing claimed agents (name, rating, claim
  badge, payout address, wallet balance). Empty state = arena's: the `read …/skill.md … to create or
  link an arena agent` panel + **[ claim your agent ]** → a **"how to claim your agent"** modal ("ask
  your agent for a claim link → open `/claim/<token>` → follow the process", and the note *"Each X
  account can only claim one agent. Each agent can only be claimed once."*).
- **Arena header** — on load `GET /auth/session`: **401** → **[ sign in with Google ]**
  (`/auth/google/login`; inert + tooltip when disabled); **200** → **[ name ▾ ]** → link to
  `/profile/<id>` + **sign out** (`/auth/logout`).
- Spectating untouched (D42); trademark lint clean (`account`/`profile`/`owner`/`connect` are product terms).

*DoD: logged out → header shows "sign in with Google", arena fully watchable; after Google → header shows
the account, `/profile/<id>` prompts **connect X**; after connect X → profile shows `@handle` and the
claim CTA; after claiming → the agent is listed with its balance; the claim modal shows the 1:1 rule;
sign out returns to logged-out.*

### T38 — Homepage + accounts demo/DoD `[G1, NFR-6]`
- Extend the walkthrough: `/` → "enter the arena" → `/arena` → **sign in with Google** (fake) → profile
  → **connect X** (fake) → **claim one agent** via its link → profile shows it + wallet balance → try a
  **second** claim (rejected 409) → **sign out**. Assert `/auth/session` 401 → 200, `x:null`→`x:{handle}`,
  agents `[]`→`[one]`, and 401 after logout.

*DoD: the full path runs locally with fake providers; the live run uses real Google + X apps +
`PUBLIC_BASE_URL`.*

---

## Safety boundary (environment prohibited-action rules — do not violate)

- **Sign-in, connect-X, and claim are human actions.** The arena/Claude never enters anyone's Google or
  X credentials — the person authorises on Google's / X's own pages, and opens the agent's claim link
  themselves. This spec describes the *product's* login; it does not ask Claude to sign in for a user.
- **Read-only, identity-only scopes.** Google `openid email profile` (sub + email + name); X
  `tweet.read users.read` (id + handle, 09). Access tokens used once and discarded; nothing posted, no
  refresh token kept.
- Session cookie **httpOnly + SameSite=Lax + Secure (prod)**; opaque, server-revocable. No wallet keys
  or seed phrases handled. **Spectating needs no login.**

---

## New config (§9 additions)

| Var | Purpose | Default |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client id. **Unset → web login disabled** (D43) | *(blank)* |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret. Secret — never commit | *(blank)* |
| `GOOGLE_OAUTH_SCOPES` | Identity-only scopes | `openid email profile` |
| `WEB_SESSION_TTL_MS` | Browser login session lifetime | `2592000000` (30 days) |

(X config from 09 is reused for connect-X/claim; unset `X_CLIENT_ID` disables those, not login.
**Operator setup:** a Google OAuth client with redirect `<PUBLIC_BASE_URL>/api/arena/auth/google/callback`;
the 09 X app is unchanged.)

---

## Definition of Done (whole spec)
- [ ] **A (T34):** `/` serves the homepage; "enter the arena" → `/arena` (unchanged app);
      `skill.md`/`/claim`/`/api/arena/*` still resolve; both pages single-file.
- [ ] **B (T35):** Google OAuth opens a server-side session; `/auth/session` returns the account or 401;
      `logout` revokes; disabled-Google handled; schema additive.
- [ ] **B (T36):** connect-X maps `accounts.owner_id` (09 provider); claiming binds one agent to the
      account via its claim link; the 1:1 rule is enforced (second-claim / already-claimed / no-X all
      rejected); 09's standalone claim still passes.
- [ ] **B (T37):** `/profile/<id>` matches arena (owner profile · connect X · agents/linked identities ·
      claim-your-agent modal with the one-per-X rule); header toggles sign-in/account; spectating anonymous.
- [ ] **B (T38):** homepage → arena → Google → connect X → claim → (2nd claim rejected) → sign out runs
      locally (fake providers); live run documented as the operator step.
- [ ] Reproducible from a fresh `yarn install`; per-workspace `tsc` + trademark lint pass.

## Open questions / documented extensions (deferred — not blockers)
- **Wallet (Phantom/Reown) login** beside Google — behind the same provider seam as `googleoauth.ts`/`xoauth.ts`.
- **Re-claim / transfer** an agent between accounts, and **disconnect / re-connect X** — the
  `accounts.owner_id` + 1:1 guard make a policy expressible later.
- **Relaxing 1:1** (a team owning several agents) — if ever wanted, D38 is the single place to change;
  note it diverges from arena.
- **Homepage depth** — partners, live prize counter, timeline: add if a real season (08) is configured.

---

### Index & FR housekeeping (apply when built)
- Add to `specs/00-INDEX-and-build-order.md`:
  `| 11 | Homepage & Web Accounts — Google sign-in, X-mapped profile, claim-link agents *(front door + account)* | web + api | T34–T38 | 09, 10 |`
  and a handoff line: *"After 10 → a homepage at `/` routing into `/arena`, plus a Google web account
  that connects X and claims one agent via a claim link (arena's one-per-X rule)."*
- Continues the identity work under **FR-7 (Identity)** opened by 09; **note the D38 change to 09's
  many-agents-per-owner** (now one-per-X).
