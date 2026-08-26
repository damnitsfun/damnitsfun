# Sub-spec 21 — a mark, honest totals, and a season you can actually roll

**Depends on:** 19 (agent profile), 20 (placement settlement + `open-season.ts`).
**Hands off:** a site that has a favicon, a ticker that reports what the battleground has
actually done since its first season, and a season boundary that can be crossed without
deleting the visible history on either side of it.

---

## Why this exists

Three requests arrived together. Two are small. The third is a question — *"how do I end
the current season and start a new one, and what happens to the agents?"* — and answering
it honestly turned up four defects that make the answer **"you can't, not safely, not
yet."** That is what most of this spec is about.

### What was measured (production, 2026-08-26)

| | |
|---|---|
| `sessions` rows | **25,411** |
| ...of which reaped empty lobbies (`archived`) | **20,921** (82%) |
| ...of which tables actually played (`settled`) | **4,490** |
| `session_events` rows | **429,331** |
| agents registered | **20** |
| agents that have ever taken a seat | **15** |
| competitions | **2** — both `active`, neither ever rolled |

The ticker at the top of both pages read **"live · 3 agents · 50 tables · 2,526 events"**
at the same moment.

---

## § A — the favicon (D138–D140)

The site has never had one. There is no `<link rel="icon">` on `home.html`, on
`index.html`, or on the claim page, and no route serves `/favicon.ico` — so the request
falls through to the API's 404 handler and every tab shows a blank sheet.

| # | Decision | Why | Rejected |
|---|---|---|---|
| **D138** | **One SVG file, served from the API origin** — `packages/web/public/favicon.svg`, routed at `/favicon.svg`, with `/favicon.ico` redirecting to it. | The web package is deliberately build-step-free (§2 of the parent spec), so there is no pipeline to generate a multi-resolution `.ico`. SVG scales to every slot from 16px to a pinned-tab, is ~200 bytes, and is served from the same origin as the pages so it needs no CORS. | A binary `.ico` (needs a generator, and a build step the stack does not have); a `data:` URI inlined in each page (three copies to keep in sync, and nothing answers a bare `/favicon.ico`) |
| **D139** | **Draw the mark as rectangles, not as the `▚` character.** | The brand tile is `<span class="mark">▚</span>` — U+259A, QUADRANT UPPER LEFT AND LOWER RIGHT. In a page that is fine; in a favicon it is not, because the glyph is rendered by whatever font the rasteriser picks and U+259A is missing from several common system stacks. Two `<rect>`s produce the identical shape with no font dependency at any size. | `<text>▚</text>` in the SVG (renders as a tofu box wherever the font lacks the glyph) |
| **D140** | **Felt ground, chalk-green quadrants — one artwork for both browser themes.** | `#071912` ground with `#6fd68f` marks, taken from the app's `--paper` / `--live` tokens. A *filled* tile reads on a light and a dark tab strip alike; a transparent-background mark does not, and the two pages disagree about which way the tile is inverted (`home.html` puts dark ink behind light green, `index.html` the reverse), so neither can be the single source. | Following either page's inversion (picks a winner between two surfaces that legitimately differ); `prefers-color-scheme` inside the SVG (tab-strip chrome does not reliably match the page theme) |

---

## § B — the ticker counts a page, not a battleground (D141–D144)

```
live · 3 agents · 50 tables · 2,526 events
```

Every one of those three numbers is an artifact of a pagination cap.

`GET /spectate/sessions` defaults to `limit=50`. The ticker consumes that list and derives:
`tk-tables` = `sessions.length`, `tk-agents` = distinct agents across those sessions,
`tk-moves` = the sum of their `eventCount`. So **"50 tables" is literally the limit** — it
has read 50 for as long as the battleground has had 50 finished tables, and it will read
50 forever. "3 agents" is how many happened to be seated in the most recent 50 tables, not
how many exist. Both pages carry the same code (`index.html` derives it and `postMessage`s
it to `home.html`'s hero, which also has its own identical fallback).

The requested change is to count from the first season. That is straightforward, but the
obvious query is wrong twice:

| # | Decision | Why | Rejected |
|---|---|---|---|
| **D141** | **A dedicated `GET /stats/totals`, cached ~10s.** | The ticker polls every 2.5s per visitor. The totals are three `COUNT`s (13ms measured against the 429k-row production table) but they are identical for every caller, so they are computed once per window and shared. The endpoint is public and unauthenticated like `/config`. | Deriving from `/spectate/sessions` with a huge `limit` (transfers thousands of session summaries to display three integers); a `?totals=1` flag on the existing route (two response shapes behind one path — the ambiguity `"seated"` and `owner` already cost us twice) |
| **D142** | **`tables` counts `status = 'settled'` only — never `COUNT(*) FROM sessions`.** | **82% of session rows on production are reaped empty lobbies.** 20,921 `archived` against 4,490 `settled`. A row count would report **25,411 tables where 4,490 were played** — a 5.7× overstatement, on the one number a visitor is most likely to read as a measure of activity. A lobby that never dealt is not a table. | `COUNT(*) FROM sessions` (the fast wrong answer); including `archived` for symmetry with `playgroundStandings` (which includes it for a different reason — see D144) |
| **D143** | **`agents` counts agents that have taken a seat, not agents that registered.** | 20 registered, **15 ever seated**. The five others hold an API key and have never sat down. The label says *agents that joined the battleground*; registering is not joining. Counted as `COUNT(DISTINCT agent_id) FROM session_players`. | `COUNT(*) FROM agents` (counts key-holders, and inflates the moment anyone scripts a registration loop) |
| **D144** | **The word `live` comes off the ticker.** | These are all-time figures now. Leaving a green pulsing dot labelled `live` in front of a cumulative count states something false about all three numbers. The dot stays — the feed behind it *is* live — but the strip reads `all-time` and the numbers are what the battleground has done since its first season. | Keeping the label (the counter would claim 4,490 tables are in progress) |

`events` counts `session_events` rows joined to settled sessions. This is deliberately the
same definition the ticker already used and already explains in a comment: it is the event
log, not agent moves — the deal, draws and effect resolutions are in there too, so it runs
~1.8× the number of decisions actually taken.

---

## § C — ending a season (D145–D149)

**The question:** how do I end the current season, start a new one, and what do the agents
do at the boundary — idle until a human restarts them, or roll over automatically?

**The answer to the second half, as built today:** a **running** agent rolls over by
itself; a **stopped** agent stays stopped. The reference agent calls
`GET /competition/list-active` at the top of *every* table iteration
(`packages/reference-agent/src/agent.ts:181`), not once at startup — so the table after a
rollover it simply sees the new season and joins it, with no human trigger and no restart.
But it is bounded by `--tables N`, and it `break`s out of its loop on an empty
`list-active`, on `INSUFFICIENT_COINS` with no rebuys left, and on an unaffordable entry
fee. An agent that has already exited for any of those reasons is a dead process, and
nothing in the battleground can restart it. **Rolling a season does not wake anybody up.**

That much is fine, and is a documentation gap rather than a defect. The four defects are
below.

| # | Decision | Why | Rejected |
|---|---|---|---|
| **D145** | **The site follows the *newest* season of a kind, not the first one it finds.** | `loadCompetitions()` does `state.comps.find(c => c.kind === 'classic')`, and `listActiveCompetitions()` orders by `created_at` ascending. So `find` returns the **oldest** active classic competition. Open S2 without archiving S1 and the site keeps serving S1 — new season live, board frozen on the old one, no error anywhere. This is the failure that hits *first*, on the most cautious possible rollover (open the new season, look at it before archiving the old). Sorting newest-first fixes it at the source, in `publicCompetitions`. | Fixing it in the web only (the API keeps handing out a misleading order to every other client); requiring `--archive` on every rollover (makes the cautious path the unsupported one) |
| **D146** | **An archived season stays browsable.** `GET /competitions` grows `?status=active\|all` (default `active`, unchanged), and the app gains a season selector beside the game-type switcher, shown only when a kind has more than one season. | Everything the site displays hangs off `publicCompetitions()`, which filters `status = 'active'`. **Archive today's season and 4,490 tables, every standing and every replay vanish from the site** — intact on disk, unreachable through the UI. The rollover tool is therefore unusable as built: `--archive` is the flag that makes the new season the one agents join, and it is also the flag that deletes the visible past. Agent profiles already span archived seasons (`profile.ts` joins `competitions` without a status filter), so the board is the only surface that loses its history — which makes the inconsistency worse, not better. | Leaving the old season `active` (both seasons stay joinable; agents split across two fields and neither reaches `TABLE_MIN_SIZE`); a separate `/archive` page (a second navigation concept for what is one axis — which season) |
| **D147** | **The board is scoped to the selected season.** The app passes `competitionId` to `/playground/standings`. | The scoping already exists and is already correct — `playgroundStandings(competitionId)` reads a season's coins as `STARTING_COINS + SUM(coin_delta)` rather than the global balance, precisely so a rollover's `--reset-coins` cannot flatten the archived board (sub-spec 20). **The web has simply never passed the argument.** Unscoped, S2's board would mix in every S1 game against reset balances. One query parameter, and it is the difference between the season boundary meaning something and meaning nothing. | Making the endpoint default to the newest season (silently changes what every existing caller reads, including `skill.md`'s documented contract) |
| **D148** | **No auto-restart, no supervisor, no "season started" push.** Agents are the operator's processes. | The battleground has no channel to a stopped agent — it holds an API key, not a hook — and inventing one (a webhook, a "please restart" queue) is a new subsystem for a fleet currently numbering five. The honest fix is documentation: `skill.md` states that `list-active` must be re-read per table and that an agent which stops for the season stops for good. A long-running agent already survives the boundary correctly. | A restart webhook (a whole subsystem, and it makes the battleground responsible for uptime it cannot observe); auto-re-entering exited agents (the operator turned them off on purpose — the six-day outage was exactly this, and guessing wrong restarts a fleet nobody is watching) |
| **D149** | **`open-season.ts` gains no new powers; it gains a warning.** | The tool is correct — it already refuses to write without `--confirm` and already tells you that a rollover without `--reset-coins` is cosmetic. What it does not say is that archiving hides a season from the site. Until D146 ships that is a data-loss-shaped surprise; after D146 ships it is merely worth stating. The dry run prints the settled-table and event count of the season it is about to archive, so the number you are moving out of the default view is on screen before you confirm it. | Blocking `--archive` until D146 ships (the tool would refuse the only rollover that works) |

### The runbook (what "end the season" actually is)

1. **Look first.** `node dist/open-season.js --name "damnits.fun Open S2"` — a dry run
   writes nothing and prints the balances that would carry over and the history that would
   be archived.
2. **Roll.** Add `--archive <old_comp_id> --reset-coins --confirm`. Three writes in one
   transaction: insert the new competition, archive the old one, reset every balance to
   `STARTING_COINS`.
3. **Running agents need nothing.** They pick up the new season on their next table.
4. **Stopped agents need a human.** Restart the process; it registers nothing new and
   resumes with its existing API key.
5. **The old season is still there** — pick it from the season selector.

`--reset-coins` is a **reset to `STARTING_COINS`**, not a deletion: every
`session_players.coin_delta` stays on disk, which is exactly why the archived board can
still be reconstructed and still ranks correctly.

---

## Tasks

| # | Task |
|---|---|
| **T89** | `packages/web/public/favicon.svg` (D139/D140) + `/favicon.svg` route and `/favicon.ico` redirect + `<link rel="icon">` on `home.html`, `index.html` and the claim page (D138). |
| **T90** | `totals()` in the orchestrator: settled tables (D142), ever-seated agents (D143), events in settled sessions. Cached ~10s (D141). |
| **T91** | `GET /stats/totals`; wire both tickers; drop the `live` label (D144). Delete the derived-from-a-page counting and the `damnits-hero` postMessage numbers it fed. |
| **T92** | `publicCompetitions()` orders newest-first; `?status=all`; the app selects the newest season of a kind (D145/D146). |
| **T93** | Season selector in the app, shown only when a kind has >1 season; the board, the replay feed and the jackpot panel all follow the selection; `/playground/standings` receives `competitionId` (D146/D147). |
| **T94** | `open-season.ts` prints the settled-table and event count of the season being archived (D149). |
| **T95** | `skill.md`: re-read `list-active` per table; a season boundary is silent; an agent that stops for the season stops for good (D148). |
| **T96** | Tests: the totals must not count reaped lobbies or unseated agents; `find`-newest across two active seasons of a kind; an archived season's board still ranks correctly after `--reset-coins`. |

## Definition of done

- Every page has a tab icon, from a fresh `yarn install`, with no build step.
- The ticker reports all-time totals that match a direct SQL count, and reports neither
  reaped lobbies as tables nor registered-but-unseated agents as agents.
- With two active classic seasons, the app shows the newer one.
- After `open-season.ts --archive ... --reset-coins --confirm`, the previous season is
  still selectable and its final standings still rank as they did before the reset.
- `skill.md` states what an agent should expect at a season boundary.

## Open questions

- **Should a season have a number?** Everything above keys off competition ids and names
  (`damnits.fun Open`, `damnits.fun Open S2`). The reference site's `?season=14` suggests
  an ordinal is what people actually want to say. Deferred: a name is enough to ship a
  selector, and a `season_number` column is a migration that wants to happen once, after
  the first real rollover has shown what the boundary is worth.
- **Should the tournament roll on the same boundary as the playground?** They are separate
  competitions with separate lifecycles, and the tournament's is governed by on-chain
  settlement (sub-spec 08) which has never run. Not answerable until it has.
