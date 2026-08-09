# Contract deployment record

The on-chain half of the arena: `DamnitsEscrow` (sub-spec 05, per-table entry
fees and commit-reveal) and `DamnitsTournament` (sub-spec 08, the pooled prize
and jackpot). Fill in the **Deployment record** below once each contract is
live; sub-spec 07's demo cites these values.

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

Both contracts share one operator, `0xF977F34dB8a986A0A9edec3E744092c715EF793c`
— that is correct *within* an environment, and only ever wrong across them.

#### `DamnitsEscrow` (sub-spec 05)

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

#### `DamnitsTournament` (sub-spec 08)

| Field | Value |
|---|---|
| Network | BNB Smart Chain Testnet (chain ID 97) |
| Contract address | `0x9B03Ae8dbda61f5FA7933cc7329021F533727e90` |
| Deploy tx | `0xea6cc9581b89ada5e8823c120a2134dbaa00288309b7804aba0bc6ee4163dbce` |
| Operator address | `0xF977F34dB8a986A0A9edec3E744092c715EF793c` |
| Block | 124034949 |
| Gas used | 1,130,754 |
| Compiler | solc 0.8.36, optimizer on (200 runs) |
| OpenZeppelin | v5.6.1 |
| BscScan (contract) | <https://testnet.bscscan.com/address/0x9B03Ae8dbda61f5FA7933cc7329021F533727e90> |
| BscScan (deploy tx) | <https://testnet.bscscan.com/tx/0xea6cc9581b89ada5e8823c120a2134dbaa00288309b7804aba0bc6ee4163dbce> |

### Staging

Its own contract pair, deployed per `docs/deploy-aws-ec2.md` §2.7. **No address
is shared with production.**

| Field | Value |
|---|---|
| Network | BNB Smart Chain Testnet (chain ID 97) |
| `DamnitsEscrow` | `0xcDB87fB9600f585BbC591e5143c9aEB2693e4Ed9` |
| Escrow deploy tx | `0xc19bfee01fa9c1bd42917ae5a469acf13bcff0e502929f93bf9f7bdeec541b17` (block 124042936, gas 748,832) |
| `DamnitsTournament` | `0x121751F6410a78D763D2f2D24704cfb22AeFABc3` |
| Tournament deploy tx | `0x410fffb65c1344a0fdaf9d949a0a7c7ec798709263c4f4a81a6f563dc4b7d3b3` (block 124043309, gas 1,130,754) |
| Operator address | `0xF977F34dB8a986A0A9edec3E744092c715EF793c` — **shared with production, deliberately** (see below) |
| Deployed | 2026-08-09 |

> ### The operator key is shared; the contracts are not
>
> A deliberate tradeoff, not an accident. Separate contracts mean staging can
> never touch production's commit-reveal record or its balances, and
> production's on-chain history stays demo-clean.
>
> What it does **not** fix is nonce contention: one account signing from two
> processes, each tracking its nonce independently, yields
> `replacement transaction underpriced` / `nonce too low` when both settle at
> once — and production is as likely to lose the race as staging. Expect it only
> under genuinely concurrent settlement.
>
> Both contracts expose `transferOperator(address)`, so this is reversible
> without redeploying. To split the key later: `cast wallet new`, fund it, then
> point staging's two contracts at it and update staging's
> `OPERATOR_PRIVATE_KEY`.
>
> ```bash
> cast send <staging-escrow>     "transferOperator(address)" <new-operator> \
>   --rpc-url "$BSC_TESTNET_RPC_URL" --private-key "$OPERATOR_PRIVATE_KEY"
> cast send <staging-tournament> "transferOperator(address)" <new-operator> \
>   --rpc-url "$BSC_TESTNET_RPC_URL" --private-key "$OPERATOR_PRIVATE_KEY"
> ```

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
