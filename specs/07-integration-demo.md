# Sub-Spec 07 — Integration & Demo Rehearsal

**Silo:** all (this is the assembly + dress rehearsal)
**Parent tasks covered:** T18 (end-to-end demo rehearsal)
**Depends on:** 05 (on-chain settlement) AND 06 (frontend + agents) — both complete.
**Handoff artifact:** one rehearsed, end-to-end, no-manual-intervention demo run with captured BscScan links.

## Goal
Prove the whole thing works together, exactly as it will at Demo Day, well before Demo Day. This is not new construction — it's assembly, dress rehearsal, and capturing the artifacts (transaction links, a clean run) the pitch depends on.

## Read first
Requirements §3 goals G1/G2, NFR-6 (auditability of the demo), and the parent spec's fallback/cut order (Requirements §5.2) in case something isn't ready.

## Scope

**T18 — End-to-end demo rehearsal.** Run the full path in one sitting, with no manual intervention:
1. Two or more **independent** reference-agent processes (06) register and join via the public API + skill file.
2. Entry fees are paid and verified on-chain; the escrow (05) holds the pot.
3. A seed is committed on-chain before play (05/T13).
4. A full 4-player game plays out autonomously, watchable live in the spectator UI (06).
5. The game settles: winner determined, result hash + seed revealed on-chain (05), prize paid from escrow.
6. The leaderboard updates (04/T11).
7. Capture the BscScan links for the entry-fee, commit, and settlement transactions for the pitch.

*DoD: the exact Demo Day script runs start-to-finish without manual intervention, at least once, well before Aug 30 — with the on-chain tx links captured.*

## What "done" really means here (the project's top-level goals)
- [ ] **G1:** two independent agents complete a full session via the public API with zero manual intervention.
- [ ] **G2:** entry-fee escrow, payout, and the result/seed commitment are all verifiable on BscScan (testnet acceptable).
- [ ] **NFR-6:** at Demo Day it's possible to show a live match, its leaderboard update, and the corresponding on-chain transaction(s) on a block explorer.

## Fallback handling (if something isn't ready at rehearsal time)
Apply the parent/Requirements §5.2 cut order in priority — never cut the escrow/payout contract, the agent API + skill file, or one working autonomous demo:
- VRF was already cut to commit-reveal (done in 05).
- If commit-reveal wiring (05/T13) is flaky: fall back to a published seed-hash without full on-chain reveal, but keep escrow + payout on-chain.
- If 4-player is unstable in the live demo: fall back to 2-player heads-up (engine supports it; simpler turn logic) — but this is a last resort since table size is a confirmed decision.
- If the LLM/heuristic agent misbehaves live: run the deterministic heuristic reference agent only.

## Pre-Demo-Day checklist
- [ ] The rehearsal has been run successfully at least once end-to-end.
- [ ] Tx links are saved and load correctly on BscScan.
- [ ] A written run-book exists: exact commands/steps to reproduce the demo live, so nobody is improvising on stage.
- [ ] The unconfirmed hackathon logistics (Requirements §12.2 — deadline, submission portal, rubric, mandatory-on-chain) have been verified in the participant group and any resulting requirements are satisfied.
