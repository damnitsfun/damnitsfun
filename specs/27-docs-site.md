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

**D218 — production's copy is the only copy.** No `docs-staging` subdomain. The
file is static and previewable with `python3 -m http.server` in the directory;
inventing a second environment for a page with no state is ceremony. The known
ceiling below says when that stops being true.

**D219 — the docs site links to the app, never reimplements it.** No live
leaderboard, no embedded replay, no login. Those exist at `damnits.fun` and a
second implementation is a second thing to fix. Links out, always.

## The six sections

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
- **T161** — the page itself: `packages/docs-site/public/index.html`, six
  sections, sticky anchor nav, the site's own fonts and palette by copy (the
  fonts are served from the app origin and the docs host proxies `/fonts/*`
  through with `/api`), responsive at 400px, dark/light per the existing pages.
- **T162** — the `GET /config` fill (D214): one `fetch`, `.cfg-*` spans, and a
  page that still reads correctly if the request fails — static fallback text in
  the span, replaced on success. A docs page that renders "—" because the API
  blinked is worse than one that is briefly stale.
- **T163** — `deploy/nginx-damnits.conf`: a `docs.damnits.fun` server block —
  `root` at `<APP_ROOT>/app/packages/docs-site/public`, `location /api/` and
  `location = /skill.md` and `location /fonts/` proxying to
  `damnits_production`, gzip on, a `robots.txt` that allows indexing and points
  at `skill.md`, and cache headers short enough that a deploy is visible
  (`max-age=300`).
- **T164** — `docs/deploy-aws-ec2.md`: the DNS A record, the `certbot` line
  extended with `-d docs.damnits.fun`, and one paragraph in the ASCII diagram at
  the top so the third hostname is not a surprise.
- **T165** — cross-links both ways: the homepage and the app FAQ gain a "docs"
  link; `skill.md` gains one line near the top saying where the human version
  lives. One line, not a section — `skill.md`'s reader is not the one who needs
  it.

## Definition of done

`https://docs.damnits.fun` serves the six sections over TLS; the numbers on it
match `GET /config` on production at the moment of loading; `yarn lint` passes
with the new package scanned by both linters; the page is legible at 400px wide
and in dark mode; and the API can be stopped without the docs site changing in
any way except the fetched numbers falling back to their static text.

## Known ceiling

One file, no search, no versioning, no staging copy. That holds while the site
is six sections that one person edits. It stops holding at the first of: someone
wants a page per topic for linking and SEO, the file passes roughly 2,000 lines,
or an API version ships that makes "the docs" and "the docs for v1" different
documents. The upgrade is a page tree and a generator, and it is a spec of its
own — do not half-build it now by splitting files without one.
