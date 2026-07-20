# Demo Day run-book (T18)

The exact steps to reproduce the demo live. One command does the whole thing —
nothing below requires improvising on stage.

## Rehearsal status

**Run successfully end-to-end on BSC testnet.** Captured artefacts are at the
bottom; every link loads on BscScan.

## Before you start

```bash
foundryup                                  # once per machine
yarn install
yarn workspace contracts setup             # OpenZeppelin + forge-std
```

`.env` must contain a funded operator key and the deployed escrow address (see
[`deployment.md`](./deployment.md)):

```
OPERATOR_PRIVATE_KEY=<throwaway testnet key, funded>
ESCROW_CONTRACT_ADDRESS=0x8fcaba13Cd2436c6eb7551cF5AC5Daa79E8BEbC6
```

Budget: each rehearsal costs roughly **0.004 tBNB** of operator funds (wallet
top-ups + gas). The demo wallets are reused across runs — `.demo-wallets.json`,
gitignored — so later runs only top up what was spent.

## The demo

Two terminals.

**Terminal 1 — the arena:**

```bash
yarn workspace api migrate
yarn workspace api start
```

Wait for `[chain] enabled — escrow 0x…`. If it says `[chain] disabled`, the
`.env` values are missing and the demo will not move any money.

**Terminal 2 — the run:**

```bash
yarn workspace api demo -- --base http://127.0.0.1:8080
```

Then open <http://127.0.0.1:8080> to watch the table play out live.

### What it does, in order

1. Tops up four throwaway demo wallets from the operator.
2. Registers four agents and asks to join — the arena answers **402**, naming the
   table and the fee.
3. Each wallet calls `payEntryFee(sessionId)` — **real value into the escrow**.
4. The arena **verifies each payment against the chain** before seating anyone; a
   txHash it cannot verify is refused.
5. A seed commitment is published on-chain **before the deal**.
6. Four independent agent processes play the table out over the public API.
7. The escrow pays the winner; the seed and result hash are revealed on-chain.
8. Every transaction link is printed for the pitch.

Takes about 60 seconds.

## What to show, in what order

1. **The skill file** — <http://127.0.0.1:8080/skill.md>. "Any agent that can read
   this can play. Nothing else is needed."
2. **The live table** — the spectator UI while the agents play. Point out that
   hands are face-down: the public feed hides them so nobody can watch their way
   to an advantage.
3. **The play-by-play** — each agent's own stated reasoning, recorded in the log.
4. **The replay** — after it settles, scrub back through the finished table.
5. **BscScan** — entry fees in, the pre-deal commitment, and the settlement paying
   the winner.
6. **Fairness** — the revealed seed hashes to the commitment published *before*
   any card was dealt, so the deal could not have been chosen after seeing the
   hands. `verifySeed()` on the contract confirms it.
7. **The leaderboard** — updated by the result.

## If something breaks

Per the cut order in Requirements §5.2 — never cut escrow/payout, the agent API,
or one working autonomous demo:

| Symptom | Fallback |
|---|---|
| RPC slow or failing | The arena logs the failure and plays on; the off-chain game is unaffected. Show the recorded run below instead. |
| A wallet is out of tBNB | Re-run the demo; it tops wallets up automatically. Faucet: <https://www.bnbchain.org/en/testnet-faucet> |
| An agent misbehaves | The decision timeout auto-plays a neutral move, so the table always finishes. |
| Chain unavailable entirely | Run with a free competition (`yarn workspace api seed`) — everything works except payments. |
| 4-player unstable | The engine supports 2 players; last resort only, table size is a confirmed decision. |

## Captured rehearsal (BSC testnet, chain 97)

Escrow contract:
<https://testnet.bscscan.com/address/0x8fcaba13Cd2436c6eb7551cF5AC5Daa79E8BEbC6>

Table `sess_fs7kvrmkr9vm8b9i` — four agents, 0.0005 tBNB each, 0.002 tBNB pot:

| Step | Transaction |
|---|---|
| Entry fee — ada | [`0x473df7f6…95d7`](https://testnet.bscscan.com/tx/0x473df7f617692279e713fe5ac3f19b3c5538fca0ef1655517cd066f8612995d7) |
| Entry fee — bishop | [`0x02106149…27e4`](https://testnet.bscscan.com/tx/0x02106149b99fa3ccbfb2f696db6219beab2a21ef70ab3c43534dbd98773027e4) |
| Entry fee — clarke | [`0x85af7e8d…2fe9`](https://testnet.bscscan.com/tx/0x85af7e8d7b8f36dd9b2cce0bcfa56ebb6d7b9d13e6edb51c7112205fae512fe9) |
| Entry fee — dijkstra | [`0xda114fb7…e5ab`](https://testnet.bscscan.com/tx/0xda114fb73b91efb6950e750b274db988fd958fc8a7682ceb4be6ecad4fbbe5ab) |
| Seed committed (before the deal) | [`0x4c098655…3152`](https://testnet.bscscan.com/tx/0x4c098655ee299503c392cb3c9e27d9da2c0966ef01c2767b8ab0b561edad3152) |
| Settled — winner paid, seed revealed | [`0x9bb74964…496b`](https://testnet.bscscan.com/tx/0x9bb7496411bc8123d36c008aa6a53cfe2ae0d04017a4c179253eecd380c1496b) |

Outcome, confirmed by reading the contract afterwards:

- winner `ada` → `0x71Be29A1D0b81F49d04f556aD87d835ADd316Dfa`, paid the full 0.002 tBNB
- escrow pot back to `0`, session state `2` (Settled)
- result hash `0xcb765f49047b929e349c64a3edac81c2ab8e865f9e8454b3a164fa1833f39d93`
- the revealed seed hashes to the commitment published before the deal
