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

## Demo Day shot list (sub-spec 23, T124)

The order above is the *mechanics* of a game. This is the order that makes an
outsider believe it is real, and it is what the submission video should follow.
Every step is a click, not a claim — the point is that nothing here requires
taking our word for anything.

Record against a **publicly reachable deployment** (`damnits.fun` or staging), not
a laptop: identities cannot register from localhost, because the registry resolves
the agent's document before accepting it and rejects loopback addresses.

| # | Shot | What it proves |
|---|---|---|
| 1 | `POST /register` a fresh agent, on camera | Onboarding is one HTTP call. No wallet, no funding, no signup. |
| 2 | Its `GET /agent/me` — `walletAddress` populated, `erc8004AgentId` still `null` | It was issued a wallet it never asked for, and identity is arriving. |
| 3 | Re-read `/agent/me` a moment later — `erc8004AgentId` is now a number | It has an on-chain identity, registered by its **own** wallet. |
| 4 | Its `GET /agent/{id}/erc8004.json` | The public document the chain points at, naming its wallet and its record. |
| 5 | The registration tx on BscScan — `effectiveGasPrice` **0** | Onboarding cost the agent nothing: BNB Chain's MegaFuel paymaster sponsored it. |
| 6 | Find the agent on **8004scan** by its address | It is discoverable from outside this site, in BNB Chain's own agent ecosystem. |
| 7 | The agent plays a table — spectator UI, hands face-down | It is autonomous, and the public feed cannot be used to cheat. |
| 8 | The finished replay, scrubbed back | Every move is recorded, including each agent's stated reasoning. |
| 9 | The replay's own **commit tx** and **settlement tx** links | The shuffle was committed before the deal and revealed after — click it, don't claim it. |
| 10 | The tournament contract link → **verified source** on BscScan | The escrow is readable. Anyone can check what it does with the money. |
| 11 | The leaderboard, and the payout depth sentence | The board ranks by the same order the prize is split by, and the page reads that depth from the server. |

Steps 3 and 5 are the two worth rehearsing. Registration lands within a pass of
the agent being created, but it is asynchronous by design — if it has not arrived
yet, say so and carry on rather than waiting on camera; the whole point of D176 is
that nothing depends on it.

## Answering "why this DeFi protocol?" on stage (sub-spec 24)

The staked season parks deposits in a yield protocol while a season runs. Expect
one question about that choice, and answer it with the criterion rather than the
name — the architecture is the answer:

> "The yield source is a plug. The vault knows one interface, and there are three
> implementations behind it — off, a mock for the demo, and the live protocol. We
> pick per network on two things, in this order: **can we get out instantly**, and
> then the rate. A season pays its winners the moment it resolves, and anyone can
> force the refunds the second the deadline passes — so a protocol that locks funds
> for seven days is unusable to us **at any rate**. On chain 97 the only thing that
> survives that filter is Venus. Swapping it is a constructor argument."

If they push — *"Lista pays 0.91%, seven times more, why not that?"* — that is the
good question, and it has a measured answer:

| | instant exit? | on chain 97 | rate |
|---|---|---|---|
| **Venus** | **yes** | deployed, deposits open | 0.13% |
| Lista | no — **7-day** unstake | **not deployed at all** | 0.91% |
| Ankr | n/a | deployed, but **frozen at zero — earns nothing, ever** | 0% |
| BNB native staking | no — **3-day** wait, **1 BNB** minimum | n/a | — |

Two things never to say, both of which cost more than they earn:

- **"We use the best-yielding protocol."** We do not, deliberately — see the table.
  It is also an unverifiable superlative, and a judge who disproves one claim stops
  believing the checkable ones.
- **Any percentage, projected yield or APY** (D193). The interest is pennies, the
  arithmetic is published in the submission's *"what we deliberately did not build"*
  table, and the product claim is the **refund** — which is enforced by the contract
  and provable with a transaction link. Lead with that, not with the yield.

## Staked-season shot list (sub-spec 24, T141)

**Not yet rehearsed.** Run it once on staging before Demo Day — especially step 6,
which is the one that cannot be faked and the one nobody expects.

Open the season with deadlines in **minutes**, not days, so the whole arc fits in
the demo. `--registration-hours` accepts fractions:

```bash
node dist/create-tournament.js --name "Staked S1" --staked \
  --deposit-wei 1000000000000000 \
  --registration-hours 0.08 --resolve-hours 0.17 \
  --seed-pool-wei 100000000000000000 --confirm-spend
```

| # | Shot | What it proves |
|---|---|---|
| 1 | `GET /competitions` — `entryModel: "staked"`, both deadlines | The promise is a published field, not a sentence in our copy. |
| 2 | The vault on BscScan — `getSeason` showing the same two timestamps | The deadline is on chain, readable by anyone, **before** a single deposit exists. |
| 3 | An agent calls `/competition/enter`, gets `402 DEPOSIT_REQUIRED` with `refundable: true` | The arena asks for a stake and says so in the same breath. |
| 4 | It calls `deposit(bytes32)` and retries with the txHash | The agent paid from its own wallet; we verified the event rather than trusting the hash. |
| 5 | `closeRegistration` → the pot moves into the yield source; the balance climbs on screen | The money is actually working, at a mock rate set high enough to watch. |
| 6 | **A wallet that is not the operator calls `exitStale(seasonId)`** after `resolveBy` | The refund does not need us. This is the whole spec in one click, and it is the shot to rehearse. |
| 7 | A depositor that played **zero tables** calls `withdraw()` and receives 100% | Eligibility gates prizes, never refunds. |
| 8 | A winner calls `withdraw()` and receives refund + prize together | One `owed` ledger, one call, both kinds of money. |
| 9 | The treasury's swept interest on BscScan | The mechanism is real — and we name the amount rather than a percentage. |

If asked "how much does it earn?", answer with the arithmetic, not a rate: a
thousand players staking 0.01 BNB for a week earn $1.32 between them. That is in
the submission's *what we deliberately did not build* table on purpose.


## If something breaks

Per the cut order in Requirements §5.2 — never cut escrow/payout, the agent API,
or one working autonomous demo:

| Symptom | Fallback |
|---|---|
| RPC slow or failing | The arena logs the failure and plays on; the off-chain game is unaffected. Show the recorded run below instead. |
| A wallet is out of tBNB | Re-run the demo; it tops wallets up automatically. Faucet: <https://www.bnbchain.org/en/testnet-faucet> |
| An agent misbehaves | The decision timeout auto-plays a neutral move, so the table always finishes. |
| ERC-8004 id still `null` | Expected on a local box (identities need a public URL) and harmless anywhere: registration retries every pass. Show the document at `/agent/{id}/erc8004.json` instead — it resolves either way. |
| Registration suddenly costs gas | MegaFuel's sponsorship is somebody else's policy and can be withdrawn. The agent's wallet is empty, so registration simply fails and retries; the game is unaffected. Drop shot 5. |
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
