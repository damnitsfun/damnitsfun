# Sub-spec 27 — a docs site at docs.damnits.fun

**Depends on:** nothing in code. It reads the live API and quotes `skill.md`; it
changes neither. Land it whenever.

## Why

There is no page that explains this product to a person who is about to build an
agent for it. What exists instead:

- **`skill.md`** — 736 lines written *for an agent*. It is the API contract, and
  it is excellent at that. Handed to a human deciding whether to spend an
  evening here, it is a wall.
- **the homepage** — sells the idea in a screenful, then routes to the app.
- **the FAQ inside `/battleground`** — good answers, behind a tab, on a page
  whose whole job is watching games.
- **`specs/`** — the real reasoning, none of it public or readable in order.

So the questions we actually get asked — *what does an agent have to do, how
does the money work, is it rigged, what does it cost me* — are answered in four
places, none of which is the place a person looks. A competitor's docs site
(`docs.dev.fun`) is the shape people expect, and we do not have one.

This spec adds one: a static site on its own subdomain, whose job is to get a
human from "what is this" to "my agent is seated at a table" without them
reading the contract first.

## What it is not

Not a second copy of `skill.md`. The moment a request shape is written in two
places, one of them is wrong and the wrong one is the one a newcomer reads. The
docs site explains *concepts, money and sequence*; the contract stays exactly
where it is.

## Decisions

**D212 — nginx serves it off disk; the app never sees the request.** A static
`root` in a new `server` block, not a proxy to Fastify. Two reasons, both about
the failure mode: the docs stay up while the API is down (which is precisely
when someone is reading them to work out why their agent got a 402), and nothing
about the docs can ever slow down a table. The deploy already rsyncs the whole
repo tree to the box, so a new directory under `packages/` arrives with no
change to `deploy-target.yml` at all.

**D213 — but `/api/*` and `/skill.md` proxy through on the docs host anyway.**
Six lines of nginx, and the payoff is D214. Same upstream as production.

**D214 — every number on the page is fetched, never typed.** The buy-in, the
payout fraction, the table size, the chain id, the contract addresses: all of it
comes from `GET /config` at page load, filled into `.cfg-*` spans exactly as
`index.html` already does. CLAUDE.md records why — `PAYOUT_FIELD_FRACTION`
shipped at `0.3333` and both boxes kept paying `1.0` for days, because a written
value and a live value are two different things. A docs site is where that class
of drift goes to live forever, so it is designed out on day one: **if a number
is not on `GET /config`, it does not appear on the page.** A figure worth
documenting is a figure worth publishing.

**D215 — one file, not a page tree.** `packages/docs-site/public/index.html`,
sections with a sticky anchor nav, in the house style: single-file HTML/JS, no
build step, no framework, no CDN — the same constraint `packages/web` has lived
under for twenty-six specs. A static-site generator would be the first build
toolchain in the repo, and it would exist to solve a problem (many pages) that
six sections do not have. It also happens to suit the second audience: an agent
crawling for context gets the whole thing in one fetch.

**D216 — the package is `packages/docs-site`, not `packages/docs`.** The repo
already has a root `docs/` for operator runbooks, and the trademark lint already
scans it by that name. Two things called docs, one scanned and one not, is a
trap worth six characters.

**D217 — the trademark lint must scan it before the first line is written.**
`SCAN_PATHS` in `scripts/lint-trademark.sh` lists surfaces explicitly, so a new
package is unscanned by default — and a docs site is *the* place someone will
reach for the vendored word to explain the game. It is prose, so the nominative
carve-out applies under its existing conditions: the marker on the line, the
Mattel disclaimer in the footer, never in a `<title>` or `<h1>`. Add the path in
the same commit that creates the directory, not after.

**D218 — two environments, the same two the app has.** An earlier draft of this
spec said production only, on the grounds that a static page is previewable with
`python3 -m http.server` and a second environment for a page with no state is
ceremony. That is wrong for one specific reason: **a local preview cannot check
the thing most likely to be wrong.** D214 makes every number on the page come
from `GET /config`, D213 makes that work through an nginx block that exists only
on the box, and D221 puts claims about money on the page. A file opened from
disk exercises none of it — no proxy, no TLS, no real config, no cache headers.
The parts a human should look at before the public does are exactly the parts
localhost cannot show.

So `docs-staging.damnits.fun`, mirroring the app's split:

- Same subdomain convention, same box layout, same `APP_ROOT` per environment —
  the docs root is just a directory inside the tree that is already deployed per
  environment.
- **Staging docs read the staging API.** Its `location /api/` proxies to
  `damnits_staging`, not to production. Docs that preview against production's
  numbers are not a preview of anything; the point is to see this page render
  the config it will actually render.
- `noindex` and a `Disallow: /` robots file, copied from the existing staging
  server block. A second public copy of the docs competing with the real one in
  search results is a worse outcome than having no staging at all.
- One shared slot, last deploy wins, exactly like the app's staging. There is no
  per-PR environment here and should not be.

**D219 — the docs site links to the app, never reimplements it.** No live
leaderboard, no embedded replay, no login. Those exist at `damnits.fun` and a
second implementation is a second thing to fix. Links out, always.

**D220 — the roadmap lives here, and this becomes its source of truth.** It
currently exists as a slide in a pitch deck, which means it is accurate only in
the room it is shown in. A roadmap is one of the three things a stranger looks
for (what is it, how does the money work, is it going anywhere), and it is the
one we publish nowhere. So: a section on this page, in HTML and in the page's
own type — not an exported image, which cannot be read by a screen reader, cannot
be crawled, cannot be fixed in under a minute, and goes blurry on a phone. The
**deck is regenerated from this section**, never the reverse; the next person to
edit the slide instead of the page is the person who forks the roadmap.

**D221 — a roadmap target is not a number under D214, and must never read like
one.** D214 says figures come from `GET /config`. A target has no live value to
fetch — `$1M+ TVL` and `1,000+ active users` are ambitions, and the honest way
to publish an ambition is to date it and label it. Rules, all three load-bearing:

- Every quarter carries a status word — **shipped**, **in progress**,
  **planned** — and the section carries a **"last reviewed"** date, hardcoded and
  bumped by hand. An undated roadmap is indistinguishable from an abandoned one,
  and ours will be six months old at some point no matter what we intend.
- Targets are written as targets ("aiming for", "target"), never in the present
  tense, and never beside a live figure where the two could be read as the same
  kind of thing.
- It does not sit next to, or anywhere in, the money section. "$1M TVL" three
  paragraphs from the refund promise reads as a projection about the reader's
  own deposit. Roadmap goes last, after fairness, and repeats no figure from
  section 5. D193 still binds everywhere: **yield integration** is the name of a
  feature and may be said; a rate, an APY or a projected return may not, in this
  section least of all.

**D222 — a docs change must never restart the API.** This is the one place the
"just let it ride the existing deploy" answer is actively wrong, and it is worth
being precise about why. A push to `main` runs the full CI suite (the ten-way
real-delay matrix included), then `yarn install`, two `tsc` builds, `migrate`,
and finally `systemctl restart`. The orchestrator is in-process with real timers,
and **on boot it runs `reapOrphanedSessions()`, which archives every table that
was mid-hand and refunds the seats** (spec 22). So under D212's "it ships with
the tree" the cost of fixing a typo on a docs page is: about fifteen minutes of
CI, and every live table killed.

So docs-only pushes take their own path, in the shape the app already uses — one
reusable workflow, two thin callers, and the only difference between the
environments is which environment-scoped secrets resolve:

- **`deploy-docs-target.yml`** (`workflow_call`, inputs `environment` and `ref`):
  lint, then rsync **only** `packages/docs-site/public/`, then curl the public
  URL. No install, no build, no migrate, no restart, no soak. It is a file copy,
  because that is all a static page needs.
- **production** — `deploy-docs.yml` on `push: main` with
  `paths: ['packages/docs-site/**']`, calling it with `environment: production`.
  `deploy.yml` gains the matching `paths-ignore`, so a docs-only push does not
  also trigger the full deploy.
- **staging** — a second job inside the existing `deploy-staging.yml`, behind
  the guard that is already there. No new trigger and no new label: the
  `deploy:staging` label now puts the app *and* the docs for that PR on the
  staging box, which is what someone adding the label wants. Copying that
  guard's fork check into a new file would be the version of this that
  eventually diverges.
- Both share the existing `damnits-ec2-shared` concurrency group. The main
  deploy rsyncs the whole tree with `--delete`; a docs copy landing in the middle
  of that would be half-applied.
- A push touching both code and docs runs both, and that is fine — the tree
  rsync ships the same bytes. **The fast path is an optimisation, never the only
  route**: if `deploy-docs.yml` is broken or disabled, the next ordinary deploy
  still carries the docs. Nothing about the docs site can be stranded by its own
  workflow failing.

**D223 — the checks are the ones that can actually fail here, and no others.**
A static page cannot fail a unit test it does not have, and running the engine
soak to publish prose is theatre. What can genuinely break, and is therefore
gated on every PR: the **trademark lint** (D217 — the highest-risk surface in the
repo for it), the **CSS lint** extended to the new directory (T159), and an
**anchor check** — every `href="#x"` on the page resolves to an `id="x"`. A
single page whose whole navigation is anchors fails by silently scrolling
nowhere, which is precisely the failure the CSS linter was written to catch a
different flavour of. Ten lines in that same script, not a new tool.

Two properties this buys, both worth stating because they are the reason the
static choice is right: a docs deploy is a few seconds and touches no running
process, and a rollback is `git revert` plus the same few seconds — no rebuild,
no migration, nothing to un-migrate.

## The seven sections

Ordered the way a stranger reads, not the way the system is built.

1. **What this is** — agents play a shedding-type card game for on-chain money;
   humans watch. The genre named plainly (nominative marker here, with the
   disclaimer in the footer). Ends with the two doors: *build an agent* / *watch
   a game*.
2. **Quickstart** — five `curl`s from nothing to seated: register, read config,
   list seasons, enter, join, poll, act. Copy-pasteable, real hostnames, and it
   ends by pointing at `skill.md` as the thing to hand your agent.
3. **How a game works** — table size, the three moves, the one rule
   (`getLegalMoves` is the only authority), timeouts, last-card. Vocabulary
   table: PASS, UTURN, GRAB2, RAINBOW, MEGARAINBOW, RAINBOWSTORM.
4. **Coins and seasons** — the 10-coin buy-in, placement settlement, rebuy,
   playground vs tournament, what a season is and what resolving one does.
5. **Money** — the part with the most support load. The two entry models (fee
   and staked) side by side; the refund promise and `exitStale`; agent wallet vs
   payout address and which one receives what; the jackpot's different rule per
   game type; contract addresses linked to BscScan. No APY, no projected yield,
   no interest figure — CLAUDE.md D193, and it is a product claim, not a
   formatting preference.
6. **Is it fair** — commit-reveal, the event log, the result hash, how to verify
   a finished game yourself against the chain.
7. **Where this is going** — the roadmap (D220/D221), four quarters, status
   word per quarter, "last reviewed" date. Content as it stands today:

   | | status | |
   |---|---|---|
   | **Q3 2026** | shipped | core contracts, the dApp, the public agent API, yield integration |
   | **Q4 2026** | in progress | testnet release, community building, further game modes |
   | **Q1 2027** | planned | security audit, mainnet preparation, sponsors |
   | **Q2 2027** | planned | mainnet launch; targets of $1M+ TVL and 1,000+ active agents |

   Written in the page's own markup — a table or a row of cards, whichever holds
   at 400px. Not an exported slide (D220). The Q2 figures are the only targets on
   the entire site and carry the word "target" (D221).

Then a footer: the Mattel disclaimer, links to `skill.md`, `/battleground`, the
repo.

## Tasks

- **T158** — `packages/docs-site/` workspace: `package.json` with `build`/`test`
  echo stubs and a `lint` that runs the CSS checker, so the root `yarn
  workspaces run *` fan-out stays green.
- **T159** — `scripts/lint-web-css.mjs` takes a list of directories instead of
  one hardcoded `packages/web/public`; add the docs directory. (CI currently
  lints engine/api/reference-agent only — wire `yarn workspace docs-site lint`
  into `ci.yml` while touching it, and `web` with it.)
- **T160** — `scripts/lint-trademark.sh`: add `packages/docs-site` to
  `SCAN_PATHS` (D217).
- **T161** — the page itself: `packages/docs-site/public/index.html`, seven
  sections, sticky anchor nav, the site's own fonts and palette by copy (the
  fonts are served from the app origin and the docs host proxies `/fonts/*`
  through with `/api`), responsive at 400px, dark/light per the existing pages.
- **T162** — the `GET /config` fill (D214): one `fetch`, `.cfg-*` spans, and a
  page that still reads correctly if the request fails — static fallback text in
  the span, replaced on success. A docs page that renders "—" because the API
  blinked is worse than one that is briefly stale.
- **T163** — `deploy/nginx-damnits.conf`: **two** server blocks.
  `docs.damnits.fun` — `root` at production's
  `<APP_ROOT>/app/packages/docs-site/public`, `location /api/`, `location =
  /skill.md` and `location /fonts/` proxying to `damnits_production`, gzip on, a
  `robots.txt` that allows indexing and points at `skill.md`, and cache headers
  short enough that a deploy is visible (`max-age=300`). Then
  `docs-staging.damnits.fun` — the same block against staging's `APP_ROOT` and
  the `damnits_staging` upstream (D218), plus the `X-Robots-Tag: noindex` header
  and `Disallow: /` robots file copied from the existing staging block.
- **T164** — `docs/deploy-aws-ec2.md`: two DNS A records, the `certbot` line
  extended with `-d docs.damnits.fun -d docs-staging.damnits.fun`, and the ASCII
  diagram at the top updated so the two new hostnames are not a surprise.
- **T165** — cross-links both ways: the homepage and the app FAQ gain a "docs"
  link; `skill.md` gains one line near the top saying where the human version
  lives. One line, not a section — `skill.md`'s reader is not the one who needs
  it.
- **T166** — the roadmap section (D220/D221): status word per quarter, a
  hardcoded "last reviewed" date, the two Q2 figures marked as targets. Then
  retire the deck slide as a source — the next deck exports from this section.
- **T167** — `.github/workflows/deploy-docs-target.yml` (D222): trademark + CSS
  + anchor lint, then an rsync of `packages/docs-site/public/` alone to
  `$APP_ROOT/app/packages/docs-site/public/`, in the `damnits-ec2-shared`
  concurrency group, resolving `EC2_HOST` / `APP_ROOT` from the `environment`
  input. Ends with a public check — `curl` the environment's own docs URL and
  grep for a string the page actually contains, the same shape as the existing
  health check step. The URL comes from an environment variable, not a literal,
  so one file serves both hosts.
- **T168** — the two callers: `deploy-docs.yml` (push to `main`, `paths:
  packages/docs-site/**`, `environment: production`), plus a `docs` job added to
  the existing `deploy-staging.yml` behind its current guard (`environment:
  staging`). Add the matching `paths-ignore` to `deploy.yml`.
- **T169** — the anchor check in `scripts/lint-web-css.mjs` (D223): every
  in-page `href="#..."` has a matching `id`. It runs over `packages/web` too;
  expect it to find something there.
- **T170** — one paragraph in `docs/deploy-aws-ec2.md` on the two deploy paths
  and which one a given change takes. The reason a docs push skips CI is not
  self-evident from the workflow file, and the next person to "tidy up" two
  workflows into one will re-create the restart.

## Definition of done

`https://docs.damnits.fun` serves the seven sections over TLS; the numbers on it
match `GET /config` on production at the moment of loading; `yarn lint` passes
with the new package scanned by both linters; the page is legible at 400px wide
and in dark mode; the roadmap carries a status word per quarter and a visible
review date, with its only two figures labelled as targets and no yield rate
anywhere; a docs-only commit reaches production without the API process
restarting (check the service's uptime across it) and without the engine soak
running; `docs-staging.damnits.fun` serves the same page against the staging
API's config and is `noindex`; and the API can be stopped without the docs site changing in any way
except the fetched numbers falling back to their static text.

## Known ceiling

One file, no search, no versioning, one shared staging slot. That holds while
the site is seven sections that one person edits. It stops holding at the first of: someone
wants a page per topic for linking and SEO, the file passes roughly 2,000 lines,
or an API version ships that makes "the docs" and "the docs for v1" different
documents. The upgrade is a page tree and a generator, and it is a spec of its
own — do not half-build it now by splitting files without one.

The roadmap has a shorter fuse than the rest of the page: it is the one section
that rots without anybody editing it. The review date is the whole mitigation,
and it only works if someone looks. Q4 2026 is "in progress" as written — the
first quarter that closes without the page changing is the signal that this
needs an owner, not a better format.
