# Sub-spec 23 — the judge's first click, and an identity the chain can see

**Depends on:** 22 (per-season coins, level ties, long-polling).
**Hands off:** a contract whose source a stranger can read, a page that links the chain it
claims to use, an agent that carries an ERC-8004 identity on BSC testnet, and a submission
whose every required field has something true to put in it.

---

## Why this exists

The battleground is entered in the **Indonesia Web3 Hackathon 2026** — hosted by Coinvestasi
and Dev Web3 Jogja, in collaboration with Binance Academy and **BNB Chain**. The submission
portal is open **1–30 September 2026**; Demo Day is October 2026. The prize pool is $5,000
across three tracks, and no rubric is published anywhere.

That last fact decides this spec's shape. There is no scoring sheet to satisfy, so the work
that pays is the work that makes an outsider believe, in the first thirty seconds, that this
thing is real. Two of the portal's own fields do most of that believing for us:

> `CONTRACT ADDRESS *` — *"Automatically linked to BscScan based on the network."*

The portal turns the address we submit into a BscScan link on our own submission page. That
link is plausibly the first thing a judge clicks. Today it lands on **unverified bytecode**:
`packages/contracts/foundry.toml` has no `[etherscan]` block, and neither `Deploy.s.sol` nor
`DeployTournament.s.sol` verifies anything. We have run 4,004 real tables through a
commit-reveal escrow and the source of it is unreadable from outside.

The second is the product itself. `packages/web/public/index.html` says "on-chain" and
"revealed" fourteen times and links **zero** transactions — while the contract address is
already handed out on the competition endpoints. We assert the chain and never show it.

And there is a third thing, which is the only item in this spec that is about tooling rather
than about being legible: BNB Chain's own agent stack is built on **ERC-8004**, and both of
its registries are live on chain 97. Every agent here is already issued a custodial EOA at
registration (sub-spec 14). Giving that EOA an on-chain identity is additive — there is no
`AgentRegistry` in this codebase to migrate off, and no rule this spec has to bend to do it.

### What was checked before any of this was written

| | |
|---|---|
| ERC-8004 IdentityRegistry, chain 97 | `0x8004A818BFB912233c491871b3d84c89A494BD9e` — **deployed**, `eth_getCode` returns a proxy |
| ERC-8004 ReputationRegistry, chain 97 | `0x8004B663056A597Dffe9eCcC1965A193B7388713` — **deployed** |
| SDK | `@bnbagent/sdk@0.5.5`, MIT, TypeScript, viem-based, Node ≥ 20, published 2026-08-27 |
| MegaFuel testnet paymaster | `bsc-megafuel-testnet.nodereal.io` — **live**, answers `pm_isSponsorable` |
| ...for a dummy probe | returned `{"sponsorable": false}` — a **false negative**; see D177, where a real registration came back free |
| BSCScan REST data API | deprecated Dec 2025 — **we do not use it**; only `demo.ts:45` builds explorer URLs |

The SDK is `viem`-based and Node ≥ 20, so it drops into this stack without a second chain
client and without touching the pinned versions in `CLAUDE.md`.

---

## § A — the judge's first click (D170–D174)

**D170 — the two live contracts are verified retroactively, and every future deploy verifies
itself.** The pair on chain 97 is already deployed and must not be redeployed to gain a
verified badge — redeploying orphans the escrow rows that 4,004 settled tables point at.
So this is two separate pieces of work: a one-time `forge verify-contract` against the live
addresses, and an `[etherscan]` block plus `--verify` in the documented invocations so the
next deploy never regresses to this state.

Verification now requires an **Etherscan V2** key (`chainid=97`); legacy BscScan-issued keys
are rejected. The key is a new non-secret-ish env var — it is rate-limiting credentials, not
custody — but it goes in `.env` beside the others and in `.env.example` empty, never
committed.

**D171 — the submitted contract address is `DamnitsTournament`.** The portal takes one
address and the tournament is where the prize pool, the entry fee and the settlement live;
the escrow is the per-table anchor. Both get verified regardless — a judge who follows the
tournament to its escrow must not hit bytecode on the second hop.

**D172 — the project is MIT, and says so in a `LICENSE` file.** The repository is public but
carries no licence: `package.json` reads `"license": "UNLICENSED"` and there is no `LICENSE`
at the root. The hackathon requires a public repo and open-source work, and BNB Chain's own
evaluation guide names "public GitHub repo with proper license" outright. MIT is the only
answer consistent with what is already vendored here — the engine's own `LICENSE`
(Guilherme Ventura, MIT), OpenZeppelin, and the `SPDX-License-Identifier: MIT` already
declared at the top of both contracts. **The vendored `packages/engine/vendor/uno/LICENSE`
stays exactly where it is and is not merged into the root file** (rule 3: the vendored diff
stays minimal).

**D173 — the chain the web claims is published on `GET /config`, not hard-coded into the
page.** `/config` already exists to stop the frontend inventing deployment settings, and
spec 22's closing lesson was that a value nobody publishes is a value nobody can check. It
gains `chainId`, `escrowAddress`, `tournamentAddress` and `explorerBaseUrl`; the web reads
them and renders links. A null address renders no link rather than a dead one — a
walletless/chainless deployment (the test config, a local box) must still render.

**D174 — the payout sentence in the web comes from `/config` too, because it is currently
wrong.** `packages/web/public/index.html:2574` still reads *"the on-chain prize pays the top
10"*, and `:2757` repeats the claim. Since spec 22 D168 the pool pays **the top third of the
field, capped at ten** — `/config` has published `payoutFieldFraction` and `payoutTiers` since
that spec precisely so this could be read rather than restated. A judge who compares the page
against a settled season finds the page lying. This is a copy fix with a data source, not a
copy fix.

---

## § B — an identity the chain can see (D175–D179)

**D175 — registration is asynchronous, and `POST /register` is not allowed to get slower or
more failure-prone.** `Orchestrator.registerAgent` (`packages/api/src/orchestrator.ts:317`)
is a synchronous `better-sqlite3` transaction that mints an agent, an API key and a custodial
wallet, and returns. An ERC-8004 registration is an on-chain write against a third-party
registry over a network we do not run. Those two things do not belong in the same call.

So: three nullable columns on `agents`, filled in later.

```
erc8004_agent_id      INTEGER   -- the registry's token id; null until registered
erc8004_tx_hash       TEXT      -- the registration tx, for the explorer link
erc8004_registered_at TEXT      -- when it landed
```

They are added through `backfillAddedColumns` (`packages/api/src/db/index.ts:30`) like every
column since sub-spec 08, so an existing database takes them without a rebuild and every
pre-existing agent starts null.

**D176 — a reconciler owns registration, and it runs at boot, never from the constructor.**
Identical shape to `reapOrphanedSessions()` from spec 22: a pass that selects agents holding
a `wallet_address` and no `erc8004_agent_id`, registers them one at a time, and records the
result. It runs once at boot and once after each `POST /register`. A restart mid-flight, a
registry outage, an RPC failure — all self-heal on the next pass, because the query that
finds work is "no identity yet", not "just registered".

Failure is **recorded, not thrown**, matching the standing rule in `packages/api/src/chain.ts`:
a chain outage must never corrupt or block a finished game. An agent that never receives an
identity registers, plays, settles and gets paid exactly as before. This is decoration on a
working system and must behave like it.

**D177 — each agent registers with its own wallet, and it costs nothing. MEASURED.**

The identity registry is an ERC-721 and somebody has to own the token. Every agent's custodial
wallet holds zero tBNB, so agent-owned registration only works if it is genuinely sponsored —
which the SDK's README claims and a `pm_isSponsorable` probe appeared to contradict.

**T118 settled it, and the answer is yes.** A wallet holding exactly 0 tBNB registered
successfully on chain 97:

| | |
|---|---|
| Registering address | `0xfd311F0D78DD220e5dEeB53CAB1EE80A521E0478`, balance **0 tBNB** |
| Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` (chain 97) |
| Token id assigned | **2193** |
| Transaction | `0xe596b5397a16ff60c5406281217a1b3a9846f43e193590ddfa5c96e26d3568cc` |
| Receipt status | `0x1` — success |
| `effectiveGasPrice` | **0** |
| Gas used | 483,497, at zero price ⇒ **total cost 0 wei** |
| Elapsed | ~6 s |

Confirmed independently of the SDK by reading the receipt straight from the RPC. So the
agent's **own EOA** signs its own registration, the agent owns its own identity, and
onboarding costs nothing — no funding transfer, no operator custody of the token, and one
write per agent.

The earlier `sponsorable: false` reading was exactly the false negative it looked like: a
dummy sender and empty calldata are not a registration, and MegaFuel's policy keys on what
the transaction actually does.

**Two things this does not license.** Sponsorship is a policy someone else operates and can
withdraw, so the reconciler must still work when a registration costs real gas or fails
outright (D176 already requires this — nothing here weakens it), and T121 keeps recording the
effective gas price in production so a withdrawn policy shows up as data rather than as a
mystery. The private key is decrypted from our own AES-256-GCM store for the length of one
signature and the SDK is constructed with `persist: false`, so it never writes a Keystore V3
file to `~/.bnbagent/wallets/` — our store stays the only place a key lives at rest.

**D178 — `agentUri` is a live JSON document this API serves, not a frozen `data:` URI.** A
new public route, `GET /agent/:id/erc8004.json`, returns the ERC-8004 registration file for
that agent: name, description, its endpoints, its wallet address, and — once
`erc8004_agent_id` is known — the `registrations` block naming the registry and chain id.

Two reasons over the SDK's base64 `data:` URI. First, a `data:` URI freezes its contents on
chain at registration and can never reflect anything the agent later becomes. Second, this
one already has a sibling: `GET /agent/me` returns `profileUrl` (sub-spec 19 D127), the
public page with the agent's history and every replay. The JSON document sits beside that
page and points at it, so the on-chain identity resolves to the real product surface.

Because the URL is stable, the SDK's second registration phase (regenerate the URI with the
token id, then `setAgentUri`) is unnecessary — the document renders its own `registrations`
from the stored id. A phase-2 `ERC8004PartialRegistrationError` is therefore **caught and
logged, never retried and never fatal**; the agent is registered and the URI is already right.
One write per agent, not two.

**D179 — the paymaster is configured, observed, and never promised.** The SDK already routes
writes through MegaFuel when configured and self-pays whatever comes back unsponsorable, so
there is no paymaster code to write here and `megafuel-js-sdk` (v1.0.7, last published
October 2024, GPL-3.0, pulls in ethers) is not a dependency this project takes.

What this spec does add is a record of which path each registration actually took, because a
direct probe of `bsc-megafuel-testnet.nodereal.io` returned `sponsorable: false` and the
claim that registration is gas-free on testnet is therefore **unverified**. Store the
effective gas price with the registration and let the truth be whatever it is. Nothing
user-facing, nothing in a pitch, and no "gasless" claim anywhere until a real registration
has come back sponsored.

**Answered by T118: it is sponsored.** The test was binary and cost nothing — a wallet holding
zero tBNB either can register or it cannot, and it could: token 2193, receipt status `0x1`,
`effectiveGasPrice` 0, total cost 0 wei (D177 carries the full record). So D177 is
agent-owned, and "onboarding an agent costs no gas, sponsored by BNB Chain's own MegaFuel
paymaster" is a claim this project can now make and prove.

What does **not** follow is that it will stay true. Sponsorship is a policy operated by
somebody else and it can be narrowed or withdrawn without notice, so T121 keeps recording the
effective gas price of every registration in production. The day it stops being zero, that
shows up as data rather than as a mystery — and because D176 already requires the reconciler
to survive a registration that fails outright, nothing breaks when it does.

---

## § C — what the API tells an agent about its own money (D180)

**D180 — `GET /agent/me` gains `balances`, native only, best-effort.** The response already
carries `walletAddress` and three separate coin figures; what it has never carried is what
that wallet actually holds on chain. One `getBalance` through the client already constructed
in `chain.ts`.

Native only. The MOCK token that issue #20 proposed alongside it is rejected outright (§ D),
so there is no second balance to read.

Best-effort in the same sense as everything else that touches the chain here: a short
timeout, `null` on any failure, and never a throw. `/agent/me` is on the onboarding path that
`skill.md` sends every new agent down, and an RPC hiccup must degrade the field, not the
endpoint. No cache — `/agent/me` is not polled the way `pending-actions` is, and adding one
before there is traffic to justify it is a guess.

---

## § D — what this spec deliberately does not build

Issue #20 proposed seven changes and a research sweep surfaced a dozen more official BNB
tools. Most are rejected, and the reasons matter more than the list:

| Not building | Why |
|---|---|
| **On-chain MOCK token replacing coins** (issue #20 §1) | A chain write per seat charge and per settlement, inside the move loop. Spec 22 made `competition_agents` the balance of record after 4,004 tables found two money defects; re-implementing that ledger — including D150's level tie split — in Solidity is the highest-risk change available to us, for a fake currency. |
| **Strip Rainbow Storm, "free" Classic** (issue #20 §4) | Classic is already free: the 10-coin buy-in is off-chain. The change deletes the only on-chain payout in the playground and breaks the additive-deck invariant (rule 5) in exchange for nothing. |
| **Wins/losses/reputation on-chain** (issue #20 §6) | One write per table, across 4,004 tables and counting. ERC-8004 is designed the other way round: identity on chain, everything else behind the URI (D178). |
| **The SDK's wallet layer** | `EVMWalletProvider` writes Keystore V3 to `~/.bnbagent/wallets/`. `agent-wallet.ts` already encrypts with AES-256-GCM in the database and never lets plaintext leave the module. Taking theirs is a downgrade and a migration. Import `@bnbagent/sdk/erc8004` only. |
| **ERC-8183 agentic commerce** | A job/escrow/evaluator protocol. There is no job here. |
| **x402 / B402** | No package published under the `bnb-chain` org; the repository literally named `b402` is archived. |
| **BAP-578 Non-Fungible Agents** | Draft status, and the reference implementation is a third-party repository outside the `bnb-chain` org. |
| **BNB Greenfield** | `@bnb-chain/greenfield-js-sdk` last published May 2025, GPL-3.0, a second funded chain account, and recurring cost — to store a JSON blob. BNB Chain's own marketing claims a Greenfield module the agent SDK does not ship. |
| **opBNB** | A second deployment and a chain migration, not an integration. The escrow rows of 4,004 settled tables point at chain 97. |
| **Binance Oracle** | Nothing in this system reads a price. |

---

## Tasks

| # | Task |
|---|---|
| **T110** | Verify the two **live** contracts on BscScan with an Etherscan V2 key (`--chain 97`), without redeploying either (D170). Record both verified URLs in `docs/deployment.md`. |
| **T111** | Add `[etherscan]` to `packages/contracts/foundry.toml` (chain 97, key from env) and `--verify` to the documented `forge script` invocations in `Deploy.s.sol`, `DeployTournament.s.sol`, `docs/deployment.md` and `docs/deploy-aws-ec2.md`, so the next deploy verifies itself (D170). Add the key to `.env.example`, empty. |
| **T112** | Add a root `LICENSE` (MIT) and set `"license": "MIT"` in the root `package.json` (D172). Leave `packages/engine/vendor/uno/LICENSE` untouched. Confirm the trademark lint still passes over the new file. |
| **T113** | `GET /config` gains `chainId`, `escrowAddress`, `tournamentAddress`, `explorerBaseUrl` (D173). Extend `config.test.ts`: a deployment with no contract addresses publishes nulls and does not throw. |
| **T114** | Lift the explorer-URL helper out of `packages/api/src/demo.ts:45` into a shared spot and render links in `packages/web/public/index.html` from T113's `/config` fields — the tournament contract, and a settled table's commit/settle transactions where `sessions.commit_tx_hash` / `settle_tx_hash` exist (D173). A null address renders no link. |
| **T115** | Replace the hard-coded "the on-chain prize pays the top 10" at `index.html:2574` and the claim at `:2757` with a sentence rendered from `/config`'s `payoutFieldFraction` and `payoutTiers` (D174). Grep the whole of `packages/web` for any other restatement of the payout depth and fix each the same way. |
| **T116** | Schema: `erc8004_agent_id`, `erc8004_tx_hash`, `erc8004_registered_at` on `agents`, added via `backfillAddedColumns` and declared in `schema.sql` (D175). Every existing agent starts null. |
| **T117** | `GET /agent/:id/erc8004.json` — the registration document (D178). Public, no auth, matching `profileUrl`'s reachability. Includes the agent's `wallet_address` and, when `erc8004_agent_id` is set, the `registrations` block naming registry + chain id. Test the pre-registration case: a valid document with an empty `registrations` array. |
| **T118** | **Run first, before T119 exists.** A throwaway script: generate a wallet holding **zero tBNB**, attempt one ERC-8004 registration, record whether it succeeded and at what gas price (D179). Success ⇒ sponsorship is real ⇒ D177 flips to agent-owned. Failure ⇒ D177 stands. Delete the script after; its output is a line in this spec, not a file in the repo. |
| **T119** | The reconciler (D176): select agents with a wallet and no identity, register each through `@bnbagent/sdk/erc8004` signed by whichever signer T118 selected (D177), persist id + tx hash. Runs at boot and after each `POST /register`, **never from a constructor**. Every failure is caught, logged and left for the next pass. Pin `@bnbagent/sdk` to an exact version, and keep the signer behind one seam. |
| **T120** | Tests for T119 against a stubbed registry client: a registration failure leaves the agent playable and the row null; the next pass retries it; a successful pass is idempotent and never double-registers; `POST /register` returns in the same time whether the registry is reachable, unreachable or hanging. |
| **T121** | Keep recording the effective gas price of each registration in production, not just in T118's probe (D179) — a sponsorship policy can be withdrawn, and the log is how we would find out. No user-facing claim, no `megafuel-js-sdk` dependency. |
| **T122** | `GET /agent/me` gains `balances: { native: string \| null }` (D180) plus `erc8004AgentId` from T116. Best-effort, short timeout, null on failure, never throws. Test the unreachable-RPC case explicitly — it is the one that matters. |
| **T123** | `skill.md`: one line telling an agent it has an on-chain identity and where its document lives, and one on `balances`. Re-run the trademark lint. |
| **T124** | Extend `docs/demo-runbook.md` with the Demo Day shot list: register an agent → it receives an ERC-8004 identity → find it on 8004scan → play a table → settle on chain → follow the page's own link to BscScan and read verified source. |
| **T125** | Draft the submission copy as `docs/submission.md`, mirroring the portal's fields: tagline, problem statement, solution, and a Markdown + Mermaid project detail. Two things the form gives us for free and we should use: a **diagram of the engine boundary** (`GameSession` as sole rules authority) and one of the **commit-reveal flow**. Include a short **"what we deliberately did not build"** section carrying § D's reasoning, and a **"what's next"** section naming the ERC-8004 ReputationRegistry, the per-season batching design, and why a write per table belongs nowhere near a game loop (see Open questions). Tick **both** the AI Agents and Consumer Apps tracks — the portal allows more than one. |

---

## Definition of done

1. `yarn test` and `yarn lint` pass from a clean install; the trademark lint passes over every file this spec adds.
2. `testnet.bscscan.com/address/<tournament>` and `.../address/<escrow>` both show **verified source**, and neither contract was redeployed to get there — the addresses are the ones 4,004 settled tables already point at.
3. A root `LICENSE` exists, `package.json` declares MIT, and the vendored engine's own licence file is byte-identical to before.
4. `GET /config` publishes `chainId`, `escrowAddress`, `tournamentAddress` and `explorerBaseUrl`; a deployment with none of them configured serves the endpoint without throwing.
5. From the homepage, a stranger can reach the tournament contract on BscScan in one click, and a settled table's commit and settle transactions in one more.
6. No page in `packages/web` states the payout depth as a constant. The sentence a visitor reads agrees with `/config`, which agrees with what `settle-season.js` actually pays.
7. **T118 has been run and its one-line result is recorded in this spec**, and the signer the reconciler actually uses is the one that result selected — not a default nobody re-examined.
8. `POST /register` returns in the same time with the registry reachable, unreachable, or hanging — asserted, not assumed.
9. A newly registered agent holds an `erc8004_agent_id` within one reconciler pass, and its `GET /agent/:id/erc8004.json` resolves with a populated `registrations` block.
10. Killing the process mid-registration and restarting leaves no agent permanently without an identity: the boot pass picks it up.
11. With the registry pointed at an address that does not exist, the arena still registers agents, deals tables, settles them and pays coins — with null identity columns and a logged failure per pass.
12. `GET /agent/me` returns a native balance for an agent with a wallet, and `null` (not a 500) when the RPC is unreachable.
13. At least one agent registered by this system is findable on **8004scan** by its address.
14. `docs/demo-runbook.md` runs end to end on staging, as written, by someone who has not read this spec.
15. `docs/submission.md` fills every required field of the portal, ticks **both** eligible tracks, and its "what's next" section states the reputation position in the project's own words rather than leaving the gap unexplained.

---

## Open questions

**None blocking.** Both had a real answer available, so both are decided here rather than
left open; what follows is the reasoning, so nobody re-opens them in October.

**Is sponsored registration real on chain 97? — ANSWERED: yes, measured.** It was going to be
decided by a ten-minute test rather than by reading a README, and it was. A wallet holding
zero tBNB registered as token **2193** for **0 wei**, confirmed against the raw receipt as
well as the SDK's own return value. D177 is therefore agent-owned: every agent signs its own
registration with the EOA sub-spec 14 already issues it, and onboarding costs nothing.

The lean going in was that it *would* be sponsored — the README was specific rather than
vague, and BNB Chain markets the number of agents registered on BSC, so it has an obvious
reason to pay. That guess turned out right, which is not a reason to have built on it: the
measurement cost ten minutes and the `pm_isSponsorable` probe that preceded it said the
opposite. Had we trusted either one, we would have shipped the wrong signer.

The live question that replaces it is **durability**, and T121 is the answer: somebody else
operates this policy and can withdraw it, so production keeps recording the effective gas
price of every registration. Zero is the expected value, not a guaranteed one.

**Should the identity carry anything beyond identity? — Decided: no code, but say so out
loud.** ERC-8004 has a ReputationRegistry live at `0x8004B663…` on chain 97, and this arena
produces exactly the kind of settled, event-logged, independently verifiable record it exists
to hold. Most projects wanting on-chain reputation have to invent the data; we have 4,004
tables of it. It is a genuinely good fit.

It still does not get built, for the same reason § D rejects the MOCK token: a write per
table puts a network call inside the game loop, which is the precise thing spec 22 spent its
length making fast. The correct design batches a season into a single write — *"500 tables,
82 firsts, 1,184 coins"* — and specifying that properly (what is summarised, when it is
written, how an outsider verifies it against the event log) is a spec of its own, not a task
bolted onto this one.

What changes is that the gap gets **explained rather than left blank**. T125 writes it into
the submission's "what's next": we produce the data, here is the design, and here is why a
write per table belongs nowhere near a game loop. At a demo day judged by people who have
five minutes, a stated position on a thing you chose not to build demonstrates more than a
half-working version of it would — and unlike the half-working version, it survives the
follow-up question. Revisit after the first season closes, with real results to aggregate.
