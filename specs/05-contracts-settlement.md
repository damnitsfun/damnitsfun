# Sub-Spec 05 — Smart Contracts & On-Chain Settlement

**Silo:** `packages/contracts` (+ a seam into `packages/api`)
**Parent tasks covered:** T12 (contract implement/test/deploy), T13 (commit-reveal wiring into the API)
**Depends on:** T12 depends only on 01 (can start early, in parallel). T13 depends on 04 (needs the live API's session lifecycle).
**Handoff artifact:** a deployed `DamnitsEscrow` on BSC testnet (address recorded) and the API committing/revealing seeds + result hashes on-chain per session.

## Goal
Provide the on-chain layer that makes the arena verifiable: entry-fee escrow, prize payout, and a commit-reveal record of each match's shuffle seed and result. This is the project's headline differentiator for judging (more on-chain than dev.fun itself).

## Read first
Parent spec §8 (contract skeleton + security requirements), §2 (Solidity 0.8.36 / OZ 5.6.1 / Foundry), §9 (config: RPC, chain ID 97, operator key, escrow address). Requirements FR-6.1–6.5, FR-6.4 (commit-reveal chosen over VRF), NFR-6.

## Two-phase structure (important for scheduling)

### Phase A — T12 (can start any time after 01, parallelizable)
Implement, test, and deploy `DamnitsEscrow.sol` **in isolation** with Foundry — no backend needed.
- Contract per parent spec §8: `payEntryFee`, `commitSeed` (onlyOperator), `settle` (onlyOperator, verifies `keccak256(seedReveal) == seedCommitHash`, pays winner).
- Security per FR-6.5: OpenZeppelin `ReentrancyGuard` on `settle`, `onlyOperator` access control, checks-effects-interactions ordering. Push-payout is acceptable for MVP; document pull-payout as a known upgrade.
- Foundry test suite: correct pot accumulation, rejecting a `settle` with mismatched reveal, rejecting double-settlement, and a reentrancy-attack simulation.
- Deploy to BSC testnet (chain ID 97); record the address and deploy tx in `docs/`.
*DoD: Foundry suite passes; a real testnet deployment address + tx are recorded.*

> Because Phase A has no backend dependency, a second builder/agent can do this in parallel with sub-specs 02–04. A solo builder going linear just does it here in order.

### Phase B — T13 (must come after 04)
Wire commit-reveal into the API's session lifecycle (from 04):
- Before a session starts, generate the seed, compute `hash(seed)`, call `commitSeed` on-chain, and store the commit in the `sessions` row (§4).
- The seeded deck (02/T2) uses that exact seed, so the shuffle is determined by the committed value.
- After settlement, call `settle` with the winner, the result hash (derived from the persisted event log, 03/T7), and the revealed seed.
- Use **viem** (parent §2) for all contract calls from Node; the operator key comes from config (§9), never hardcoded.
*DoD: a full live session's on-chain `SeedCommitted` and `SessionSettled` events are independently verifiable against the off-chain event log's actual shuffle order.*

## Prohibited-action awareness (from the environment's safety rules)
The *arena backend* performs settlement calls using the operator key it controls — that's normal server operation. But note: this system must never ask a human agent-operator to paste private keys or seed phrases into it; entry-fee payment is done by the operator's own wallet/tooling and verified by `txHash`. Keep the operator key in server-side config only.

## Definition of Done (whole spec)
- [ ] Phase A: contract deployed to BSC testnet, address + tx recorded, full Foundry security suite green.
- [ ] Phase B: the API commits a seed hash before each game and settles with a verifiable reveal + result hash after.
- [ ] An outside observer can take the on-chain commit/reveal and the public event log and confirm the shuffle wasn't tampered with.
- [ ] The operator key exists only in server config; no key material is ever requested from agent operators.

## Handoff checklist to sub-spec 07
07's demo must show a real on-chain entry fee, settlement, and reveal on BscScan. Confirm the tx hashes are surfaced somewhere the demo script can capture them (logged by the API, or shown in the 06 frontend).
