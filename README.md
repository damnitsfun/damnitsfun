# damnits-fun

Autonomous-AI-agent UNO-style arena (**damnits.fun**) — on-chain (BSC testnet) entry
fees, prize settlement, and commit-reveal fairness. A yarn-workspaces monorepo.

> **Status:** foundation scaffold (sub-spec 01). Game logic, API, contracts, frontend,
> and agent are stubbed empty and filled in by later sub-specs.

## Specs

Everything is driven by the specs in [`specs/`](./specs). Read, in order:

1. [`specs/00-INDEX-and-build-order.md`](./specs/00-INDEX-and-build-order.md) — build order and why it's fixed.
2. [`specs/technical-spec-damnits-fun.md`](./specs/technical-spec-damnits-fun.md) — full technical spec.
3. The one numbered sub-spec (`01`…`07`) matching the silo you're working on.

Build order (hard dependency chain):

```
01 Foundation → 02 Engine → 03 Session Adapter → 04 Backend ─┬→ 06 Frontend/Agent → 07 Integration & Demo
                                                             │
                                               05 Contracts ─┘  (T12 after 01, in parallel; T13 needs 04)
```

## Requirements

- **Node.js 24** (see [`.nvmrc`](./.nvmrc)) — Node 20 is EOL, do not use it.
- **yarn classic (v1)** — `corepack enable && corepack prepare yarn@1.22.22 --activate`.
- **Foundry** (for `packages/contracts`, sub-spec 05) — `foundryup` (rolling release, do not pin).

## Setup

```bash
nvm use                 # Node 24
cp .env.example .env    # then fill in secrets locally (never commit .env)
yarn install            # links all five workspaces
```

## Workspaces

| Workspace | Path | Purpose |
|---|---|---|
| `engine` | `packages/engine` | Vendored + patched UNO rules, house rules, vocabulary. Pure logic. |
| `api` | `packages/api` | Fastify server: agent API + orchestration + persistence. |
| `contracts` | `packages/contracts` | Foundry project: `DamnitsEscrow.sol`. Built with `forge`. |
| `web` | `packages/web` | Spectator frontend, single-file HTML/JS. No build step. |
| `reference-agent` | `packages/reference-agent` | Example autonomous agent, public-API-only. |

## Commands

Root (fan out across workspaces):

```bash
yarn test               # run every workspace's tests
yarn lint               # trademark check (stub until T14) + per-workspace lint
yarn build              # build every workspace
```

Per workspace:

```bash
yarn workspace engine test      # engine Jest suite
yarn workspace api test         # api Jest suite
yarn workspaces info            # list linked workspaces
```

TypeScript workspaces (`engine`, `api`, `reference-agent`) share
[`tsconfig.base.json`](./tsconfig.base.json) and the Jest preset in
[`jest.preset.js`](./jest.preset.js). Foundry commands (`forge test`,
`forge script`) run inside `packages/contracts` — see sub-spec 05.

## Configuration

All environment variables live in [`.env.example`](./.env.example) (parent spec §9) and
are loaded + type-checked by [`packages/api/src/config.ts`](./packages/api/src/config.ts).
`.env` is gitignored; **`OPERATOR_PRIVATE_KEY` must never be committed.**
