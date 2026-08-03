# DamnitsEscrow — deployment record

The on-chain half of the arena (sub-spec 05). Fill in the **Deployment record**
below once the contract is live; sub-spec 07's demo cites these values.

## What the contract does

`DamnitsEscrow` holds entry fees, records a commit-reveal of each match's shuffle
seed, and pays the winner.

- `openSession(sessionId, entryFeeWei)` — operator opens a table and fixes its fee.
- `payEntryFee(sessionId)` — a player funds their own seat from their own wallet.
  The arena never handles player keys; it verifies a `txHash`.
- `commitSeed(sessionId, keccak256(seed))` — operator, **before the deal**.
- `settle(sessionId, winner, resultHash, seedReveal)` — operator. Reverts unless
  `keccak256(seedReveal)` equals the stored commitment, then pays the pot.

Anyone can call `verifySeed(sessionId, seedReveal)` to check a reveal, or recompute
it themselves from the published event log.

## Prerequisites

```bash
foundryup                              # Foundry is rolling-release; do not pin it
yarn workspace contracts setup         # installs OpenZeppelin v5.6.1 + forge-std
yarn workspace contracts test          # 19 tests, incl. a reentrancy attack sim
```

## Deploying to BSC testnet (chain ID 97)

1. Put a **throwaway** key in `.env` at the repo root (gitignored):

   ```
   OPERATOR_PRIVATE_KEY=0x<64 hex chars>
   ```

   Fund it with test BNB from <https://www.bnbchain.org/en/testnet-faucet>. This
   address becomes the operator — the only one allowed to commit and settle.

2. Deploy:

   ```bash
   cd packages/contracts
   set -a && source ../../.env && set +a
   forge script script/Deploy.s.sol:Deploy --rpc-url "$BSC_TESTNET_RPC_URL" --broadcast
   ```

3. Copy the printed address into `.env`:

   ```
   ESCROW_CONTRACT_ADDRESS=0x<deployed address>
   ```

4. Restart the API. On boot it logs `[chain] enabled — escrow 0x…`; without these
   two values it logs `[chain] disabled` and runs happily with no chain at all.

## Deployment record

> **One contract set per environment.** `staging` and `production` share BNB
> testnet 97 but must never share an escrow, a tournament, or an operator key —
> session IDs are allocated per database and would collide, and one key signing
> from two processes causes nonce contention. See
> [`docs/deploy-aws-ec2.md`](./deploy-aws-ec2.md) §2.7 for how staging's set is
> deployed; record its addresses under *Staging* below.

### Production

| Field | Value |
|---|---|
| Network | BNB Smart Chain Testnet (chain ID 97) |
| Contract address | `0x8fcaba13Cd2436c6eb7551cF5AC5Daa79E8BEbC6` |
| Deploy tx | `0xe60d9c70ebefd40bb176700682f41d1cf11ac2f4f78221e5d97d32dfce4c04ae` |
| Operator address | `0xF977F34dB8a986A0A9edec3E744092c715EF793c` |
| Block | 120201876 |
| Gas used | 748,832 |
| Compiler | solc 0.8.36, optimizer on (200 runs) |
| OpenZeppelin | v5.6.1 |
| BscScan (contract) | <https://testnet.bscscan.com/address/0x8fcaba13Cd2436c6eb7551cF5AC5Daa79E8BEbC6> |
| BscScan (deploy tx) | <https://testnet.bscscan.com/tx/0xe60d9c70ebefd40bb176700682f41d1cf11ac2f4f78221e5d97d32dfce4c04ae> |

### Staging

Fill in once `docs/deploy-aws-ec2.md` §2.7 has been run. The operator address
**must differ** from production's above — if it matches, the deploy used the
wrong key and the two environments will collide on-chain.

| Field | Value |
|---|---|
| Network | BNB Smart Chain Testnet (chain ID 97) |
| `DamnitsEscrow` | `0x…` |
| `DamnitsTournament` | `0x…` |
| Operator address | `0x…` |
| Deployed | *(date)* |

## Verifying a match after the fact

Everything needed is public once a table settles:

```bash
# 1. Read the match record (seed reveal + result hash + tx hashes)
curl -s localhost:8080/api/arena/spectate/session/<sessionId> | jq

# 2. Confirm the chain agrees the reveal matches the pre-play commitment
cast call <escrow> "verifySeed(bytes32,bytes32)(bool)" \
  $(cast keccak <sessionId>) $(cast keccak $(cast from-utf8 <seedReveal>)) \
  --rpc-url "$BSC_TESTNET_RPC_URL"
```

The commitment was published in the `SeedCommitted` event before any card was
dealt, and the seed determines the entire shuffle — so a matching reveal means the
deal could not have been chosen after seeing the hands.

## Known upgrade: pull payments

`settle` pays the winner with a push transfer. A winner whose address reverts on
receive therefore blocks its own settlement (covered by
`test_RevertingWinnerCausesPayoutFailure`). Push is accepted for the MVP per
FR-6.5; the upgrade is to credit a balance and let winners withdraw. Reentrancy is
already handled — state is finalised before the transfer, and `settle` is
`nonReentrant`.
