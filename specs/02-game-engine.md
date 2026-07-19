# Sub-Spec 02 — Game Engine (Vendor, Patch, Wrap)

**Silo:** `packages/engine`
**Parent tasks covered:** T1 (vendor), T2 (RNG patch), T3 (typed errors), T4 (house rules), T5 (vocabulary)
**Depends on:** 01 (monorepo + `packages/engine` workspace).
**Handoff artifact:** `packages/engine` exporting a patched, typed, product-vocabulary rules engine whose full test suite passes — but NOT yet the live `GameSession` class (that's 03).

## Goal
Turn the raw vendored `danguilherme/uno` library into *our* engine: seedable, typed-erroring, house-ruled, and speaking product vocabulary only. Everything in this spec is pure rules logic — no HTTP, no DB, no persistence.

## Read first
Parent spec §1 (engine decision + the three gaps), §6 (vocabulary table), §7 (adapter/errors/RNG design), and §9.2/§9.3 of the Requirements (rebrand vocabulary + house rules). The vendored library's `Game`, `deck.ts`, `card/values.ts`, and `house-rules/cumulative-draw-two.ts` are the reference implementations to build against.

## Scope & task order
Build in this exact order — each step's tests should pass before the next.

**T1 — Vendor.** Copy `danguilherme/uno` source (pin the exact commit/tag `v2.0.3`) into `packages/engine/vendor/uno`. Get its own existing Jest suite passing in-tree, unmodified.
*DoD: vendored tests pass with zero edits to vendored code.*

**T2 — RNG injection patch.** Patch `vendor/uno/src/deck.ts` so the `Deck` constructor accepts an optional seed and threads a seeded RNG into the shuffle. **Confirm the installed `shuffle` package's real RNG-injection interface first** (parent spec gotcha — do not assume it accepts a custom RNG function; verify against the actual installed version). Add a test proving two decks with the same seed produce identical order, and that unseeded behavior is unchanged.
*DoD: deterministic-shuffle test passes; all vendored tests still pass.*

**T3 — Typed error wrapper.** Implement `packages/engine/src/errors.ts` (`NotYourTurnError`, `InvalidCardError`, `MustDrawFirstError`, `InvalidFinalCallError`, `SessionEndedError`, `SessionNotFoundError`) and a string-match translation table at the adapter boundary that maps the vendored library's plain `Error` messages to these classes. Do **not** edit the vendored library's throw sites.
*DoD: a test triggers every vendored error string and asserts the correct typed class comes out.*

**T4 — House rules: timeout + Rainbow Storm.** Implement both as vendored-style house-rule plugins (the `{ setup(game) }` pattern, hooking `beforedraw`/`beforecardplay`/`beforepass`/`cardplay`) in `packages/engine/src/house-rules/`. Timeout enforces `GAME_TIME_LIMIT_MS` with lowest-hand-value resolution; Rainbow Storm follows the prior-work design (1/100,000 independent roll, all others draw 6 and skip, turn returns to actor, additive-to-108 by design).
*DoD: a ≥300-game 4-player fuzz test confirms (a) no game exceeds the time limit without resolving, (b) the Rainbow Storm card-count-additive invariant holds and is asserted explicitly (not "fixed").*

**T5 — Vocabulary translation layer.** Implement `packages/engine/src/vocabulary.ts` per parent spec §6. Everything crossing the engine's public boundary uses product terms (`PASS`, `UTURN`, `GRAB2`, `RAINBOW`, `MEGARAINBOW`, `RAINBOWSTORM`) — the vendored `Value.*` enums stay internal.
*DoD: a full game round-tripped through the engine's public surface shows only product vocabulary in its output; no vendored enum name leaks.*

## Critical constraints (from parent spec gotchas)
- Keep the vendored diff **minimal**: the only edit inside `vendor/uno` is the T2 deck RNG change. Everything else (errors, vocabulary, house rules) is layered *around* it, not inside it.
- Rainbow Storm being additive to 108 is intended — assert the invariant, never "fix" it.

## Definition of Done (whole spec)
- [ ] All of T1–T5's individual DoDs are met.
- [ ] `packages/engine` exports a clean public API (rules, legal-move checking, error types, vocabulary) with the vendored internals hidden.
- [ ] The engine has no dependency on HTTP, DB, or any other workspace.
- [ ] A clean `yarn workspace engine test` passes from a fresh install.

## Handoff checklist to sub-spec 03
03 will build the live `GameSession` wrapper on top of this. Confirm the engine exposes enough to: instantiate a game with N named players, apply a single move, read current legal moves for a given player, and subscribe to move/turn/end events — all in product vocabulary, all raising typed errors. If any of those is awkward to call from outside, fix it here, not in 03.
