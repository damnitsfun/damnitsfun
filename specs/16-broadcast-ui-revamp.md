# Sub-Spec 16 — Broadcast UI revamp (make it read as a game, not a dashboard)

**Status:** not built (spec only). Review feedback — from a friend reviewing the app and, more sharply, from the
risk that hackathon judges can't tell whether damnits is a game or a plain web app. The interface is a coherent,
well-executed **developer-console** design language applied uniformly to every surface, including the ones that
are supposed to be a spectacle. This spec re-frames the product's presentation from *documentation of a service*
to *coverage of a live competition*, without touching rules, money, or the event log.

**Silo(s):** `packages/web` (both `home.html` and `index.html`) + docs. **No API, engine, or contract changes.**
**Depends on:** 06 (spectator + trademark lint), 10 (replay-only hardening — its invariant is load-bearing here),
11 (homepage), 12 (battleground IA), 13/15 (coins + game types), and the card-face work on
`style/replay-card-visuals`. Slots **after 15**.
**Handoff artifact:** a landing page whose hero is a real game playing itself, and a battleground replay where
moves are *performed* (card flight, turn clock, agent faces, winner moment) rather than reported — with the
replay-only guarantee, the trademark lint, and the no-build-step constraint all still intact.

---

## Why this spec exists

The current aesthetic is not sloppy; it is *effective*. Monospace type, hairline rules, `§` section markers and
the `~/battleground/join` prompt say **developer tool** with total conviction. The problem is that damnits is not
a developer tool — it is four AI agents playing cards for money, which is a spectacle. Because every surface
wears the same uniform, nothing signals which one is the game.

Four findings from the design research shaped the plan:

1. **Game pages lead with the thing; SaaS pages lead with a proposition.** The dominant-hero pattern for a game
   site is key art, a trailer, or a playable fragment *first*. Our hero defers the game entirely.
2. **"Juice" is not cosmetic.** Per *Juice It or Lose It* (Jonasson & Purho), game feel comes from actions
   producing readable, satisfying feedback — easing, anticipation, follow-through, impact. The replay currently
   swaps DOM state directly: cards teleport, counts jump, winners appear.
3. **The whole AI-agent-leaderboard category looks like a dashboard** (Agent Arena, Design Arena, Steel, Galileo,
   and dev.fun's own arena are near-uniformly tables/tabs/metrics). Looking like a *broadcast* is differentiation
   nobody in the category is taking.
4. **Judging is fast and polish is scored.** MLH-style judging runs ~4 minutes per project with polish an explicit
   rubric category; the frame a judge forms in the first ten seconds is the frame they score in.

> **The reframe, in one line:** stop presenting a product, start broadcasting a sport. Every decision below
> follows from that.

**The biggest single miss:** we own a working replay of four agents playing a real hand — the most game-like
asset in the repo — and it sits below the fold, inside a box, rendering nothing until data loads, while the
landing page shows a *diagram* of a turn instead of the actual game.

---

## Design decisions locked for this spec

| # | Decision | Chosen | Alternative (not built) |
|---|---|---|---|
| D74 | Hero content | The homepage hero plays a **real settled session** from the existing public spectator feed, looping. Reuses the `index.html` renderer and event log — no synthetic or hand-authored animation of a fake game. | A scripted/canned loop; a video file |
| D75 | Animation is presentation-only | Motion **never** mutates the event log, board state, or anything derived from it. `session_events` stays the single source of truth (parent §3); the animation layer is a pure function of state transitions it observes. | Animation driving/queueing state |
| D76 | Motion budget | Every animation ≤ **320ms**, interruptible, and cancelled on replay scrub/seek. No animation may queue a backlog when a replay is scrubbed at speed. Everything folds under `prefers-reduced-motion`. | Longer cinematic transitions; uninterruptible sequences |
| D77 | Agent identity is derived, not stored | Avatar colour + 2-char monogram are computed from a **hash of `agentId`** at render time. No schema column, no uploads, no asset files, stable across tables and sessions forever. | An `avatar_url` column; uploaded images; random per-render colours |
| D78 | Two design languages, one token set | The split is by **property, not by page**: **`arena`** owns ground, identity, colour and motion (felt, agent faces, card colour, animation); **`terminal`** owns type, density and alignment (mono, `tabular-nums`, hairlines, dense rows). The two **compose** — the standings are arena ground + identity with terminal typography. The one-paste onboarding block stays pure terminal. | Splitting by page/surface — which forces a false either/or on standings, profile, rules and the game log, and pushes the same judgement call into every task |
| D79 | No audio in the MVP | Ship silent through the hackathon. Autoplay policy blocks sound until a user gesture, so the hero is silent regardless of what we build — audio only ever applies to the replay, where the play button already supplies the gesture. If added later: **synthesize with the Web Audio API** (a card snap is a short filtered noise burst; a win sting is three oscillator notes) — zero assets, no library, satisfies D80. Off by default with a persisted toggle. | Shipping audio files or a library (Howler) — both break D80; autoplaying sound in a judging room |
| D80 | No new dependencies, no build step | CSS animations + the Web Animations API + vanilla JS only. The research's tooling suggestions (GSAP, Howler, WebGL) are explicitly **rejected** — they'd break the single-file, no-build-step constraint (parent §2). | Adding an animation/audio library or a bundler |
| D81 | Commentary reuses existing data | The per-move reasoning already persisted and rendered in the *table chat* panel is attributed to an agent face inline with the move. No new endpoint, no new field. | A new commentary/LLM narration service |
| D82 | Replay-only is reasserted, not relaxed | The hero consumes **only** the finished-games feed (spec 10). No live table becomes public to make the hero livelier, and the overlay states "replay · no live hands are public" on the felt. | Airing a live table in the hero for immediacy |
| D83 | Hero session selection | Pick **one** settled session at page load and loop it for that visit. Do **not** hot-swap as new sessions settle: a hero that changes content mid-explanation is a demo liability, and a second poller on the marketing page compounds a feed read that is already heavy. Advancing-on-settle is a follow-on, not MVP. | Hot-swapping the aired session live, as `index.html` does via `airedId` |
| D84 | Mobile hero is a different cut, not a reflow | Below ~720px the hero renders a **broadcast close-up** — pile, incoming card, scorebug strip — not the stacked four-seat felt, which is too tall and pushes the headline and CTA below the fold. Mobile here is a **share** surface (a link opened from social), not a work surface: agents have no UI at all, and developers and judges are on desktop. Designed to 390×844. | Letting the desktop felt stack into the hero via the existing 720px breakpoint |

> **Why D75 + D76 together.** The event log feeds both the replay UI and the on-chain `resultHash`. An animation
> layer that could reorder, delay, or coalesce state would put a cosmetic concern on the same path as a
> consensus-critical artifact. Keeping motion a read-only observer of transitions makes that class of bug
> impossible by construction, and the interruption budget keeps a scrubbed replay honest.

---

## Scope & task order

**T51 — Motion foundation (do this first — it guards everything else in this spec).**
A tiny shared motion layer in `packages/web`: duration/easing tokens, a `prefers-reduced-motion` kill switch, and
a helper that animates an element and **cancels cleanly** on interrupt. Every later task uses it; nothing
hand-rolls a transition.
*DoD: with `prefers-reduced-motion: reduce` set, every surface in this spec renders complete and static; scrubbing
a replay at max speed leaves no animation backlog and no visually stuck card.*

**T52 — Hero is the game.**
Replace the homepage hero's static turn diagram with the felt table playing a **settled** session on a loop,
behind the headline. Reuse the `index.html` renderer rather than forking a second one. Keep the turn diagram —
move it down into `§ the game`, where explanation belongs.
- **Session choice (D83):** one settled session picked at load, looped for the visit — not hot-swapped.
- **Mobile (D84):** below ~720px render the close-up cut, not the stacked table.
- **Consolidate the feed read:** `home.html` already fetches `/spectate/sessions?limit=200` purely to compute the
  three ticker numbers. The hero needs that same feed — make it **one** request serving both consumers, not two.

*DoD: a first-time visitor sees cards being played within ~2s of load, without scrolling or clicking; the hero
uses only the finished-games feed; the page degrades to the static diagram when the API is unreachable; the
homepage makes **one** spectator-feed request, not two; and the hero is verified in-browser at **390×844 with the
headline and primary CTA above the fold**, plus 768 and 1440.*

**T53 — Perform the moves.**
Choreograph the four state transitions that carry the game, in payoff order:
- **card flight** — played card travels from its seat to the pile with anticipation, overshoot, and settle;
- **draw** — a back slides off the deck into the drawing seat's hand;
- **colour in force** — the chip flips when a Rainbow resolves to a chosen colour;
- **hand empty** — a winner moment when a seat goes out.

**Rainbow Storm gets genuine spectacle** — it is the rarest event in the product and currently just a log line.
*DoD: each of the four transitions is visibly distinct at 1× playback; all obey the T51 budget; the storm reads as
an event, not a row.*

**T54 — Agent faces.**
Derive a stable colour + monogram from `agentId` (D77) and use it everywhere an agent is named: seats, standings,
profile, event feed. Add a turn indicator and a "thinking" state on the seat whose turn it is.
*DoD: the same agent shows the same face on every surface and across reloads; colours stay legible on felt and
meet contrast on both the seat panel and the standings row.*

**T55 — Broadcast overlay.**
A sparse scorebug on the felt: four seats with coins, cards left, and whose turn; the **decision clock as a
depleting ring** driven by the real `DECISION_TIMEOUT_MS` (never hard-coded — see 12 D50); the colour-in-force
chip promoted; and the replay-only badge (D82).
*DoD: a viewer who has never read the rules can tell, from the felt alone, whose turn it is, what colour is in
force, who is closest to going out, and that they are watching a replay.*

**T56 — Stakes on screen.**
The Rainbow-Storm jackpot animates as a counter rather than being assigned, with its published odds beside it;
the tournament prize pool and coin standings get the same treatment.
*DoD: the jackpot visibly moves while watching; no figure on the page is a hard-coded literal.*

**T57 — Split the design language (last).**
Formalise D78: scope the existing paper/mono tokens to `terminal` surfaces, introduce the `arena` scope for game
surfaces, and apply. The one-paste onboarding block stays exactly as it is — it is the most confident element on
the site and gets *louder*, not restyled.
*DoD: a reader can tell at a glance which surfaces are for humans watching a game and which are for developers
wiring an agent; both themes (light/dark) still resolve on every surface.*

---

## Guardrails (things this spec must not break)

- **Replay-only (spec 10).** No live table becomes public for the sake of a livelier hero. The hero reads the
  finished feed, full stop.
- **Trademark lint (T14).** All new copy on `packages/web` uses §6 product vocabulary. Note the lint's
  nominative-use carve-out is scoped to *user-facing marketing copy* and must not be spent on code comments.
- **Engine boundary.** No legal-move logic, ordering, or card semantics may be inferred in the presentation
  layer; the animation layer only observes transitions the log already describes.
- **No build step.** Single-file HTML, no bundler, no CDN, no external assets (parent §2).
- **Config-driven numbers.** The decision clock and every economic figure come from `/config` and the API, not
  literals (12 D50).
- **Demo reliability beats polish.** Any animation that could stall, queue, or obscure state during a live demo
  is cut. When in doubt, ship the static version.

## Safety boundary
- **Presentation-only.** No money movement, no new endpoints, no schema change, no contract change, no new
  secrets, no change to what data is public. The only network reads are existing public spectator/config
  endpoints.
- The hero must not increase API load materially: reuse the existing poll cadence and fetch one settled session,
  not a stream of them.

## New / changed config (§9)
None. This spec adds no environment variables and consumes only what `/config` already exposes.

## Definition of Done
- [ ] T51 motion layer in place; `prefers-reduced-motion` yields a complete static page; scrubbing leaves no backlog.
- [ ] Homepage hero plays a real settled game on load, degrading gracefully with no API.
- [ ] Card flight, draw, colour flip, and winner moment are each visibly distinct; Rainbow Storm reads as an event.
- [ ] Agent faces are stable and identical across seats, standings, profile, and feed.
- [ ] Decision clock ring is driven by real config; whose-turn / colour-in-force / closest-to-out readable from the felt.
- [ ] Jackpot and pool animate from live data; no hard-coded figures.
- [ ] `arena` (ground/identity/colour/motion) and `terminal` (type/density/alignment) compose per D78; onboarding block untouched.
- [ ] **Narrow layouts verified in-browser**, not assumed: the hero close-up at 390×844 (headline + CTA above the
      fold), and the replay felt + card faces at 390 and 768. This clears the outstanding debt from
      `style/replay-card-visuals`, where the window could not be resized below ~1500px during review.
- [ ] Trademark lint green; replay-only test suite (spec 10) still green; no new dependency in `package.json`.

## Open questions / deferred

Two genuine unknowns remain. (Mobile treatment and the standings scope were previously listed here; both are now
decided — see D84 and D78 — and mobile verification is a DoD line rather than a question.)

- **Whether to add audio at all.** The *shape* is settled by D79 (Web Audio synthesis, off by default, gated on
  the play gesture); what's open is whether it earns its build time post-hackathon. Worth measuring against the
  fact that no one expects sound from a web app, so silence costs nothing.
- **Advancing the hero on settle.** D83 locks the MVP to one session per page load. Whether the hero should later
  hot-swap as new games settle — becoming a channel rather than a clip — is a real follow-on, gated on the feed
  consolidation in T52 landing first so it doesn't add a second poller.

---

### Index & FR housekeeping
- Add to `specs/00-INDEX-and-build-order.md`:
  `| 16 | Broadcast UI revamp — the hero plays a real game, moves are performed rather than reported, agents get faces, and the design language splits terminal/arena *(presentation-only)* | \`web\` | T51–T57 | 06, 10, 11, 12, 15 |`
- The index's *handoff artifacts* table stops at 13 (14 and 15 never added rows), so 16 doesn't add one either —
  its handoff artifact is stated at the top of this file. Worth a separate cleanup pass to backfill 14–16 if that
  table is meant to stay current.
- Supersedes nothing. It **amends the presentation** of 11 (homepage hero) and 06/10 (spectator), and depends on
  the replay-only invariant of 10 remaining exactly as specified.
