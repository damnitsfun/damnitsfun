# Sub-Spec 01 — Foundation & Monorepo Setup

**Silo:** cross-cutting (scaffolds all five)
**Parent tasks covered:** repo structure (§3), environment/config (§9), CI lint skeleton (prep for T14)
**Depends on:** nothing — this is the first thing built.
**Handoff artifact:** a `yarn install`-able monorepo with all five empty package workspaces, a working `.env` loader wired to the §9 config table, and a CI lint stub that runs.

## Goal
Stand up the empty skeleton every later sub-spec builds into. No game logic, no endpoints, no contracts yet — just the structure, tooling, and configuration wired correctly so that later work has a place to go and a consistent toolchain.

## Scope
1. Initialize a yarn (classic v1) workspaces monorepo named `damnits-fun`, exactly matching the directory layout in parent spec §3.
2. Create all five package workspaces as empty-but-valid packages: `packages/engine`, `packages/api`, `packages/contracts`, `packages/web`, `packages/reference-agent`. Each has its own `package.json` and (for TS packages) a `tsconfig.json` extending a shared root config.
3. Pin the toolchain per parent spec §2: Node **24** (add an `.nvmrc` with `24`), TypeScript, Jest 30.x for the TS packages. Do **not** add app dependencies (Fastify, viem, openskill, etc.) yet — those belong to the sub-spec that first uses them.
4. Implement a single `.env` loader and a typed config module that reads every variable in the parent spec §9 table (`PORT`, `DATABASE_PATH`, `BSC_TESTNET_RPC_URL`, `BSC_CHAIN_ID`, `OPERATOR_PRIVATE_KEY`, `ESCROW_CONTRACT_ADDRESS`, `DECISION_TIMEOUT_MS`, `GAME_TIME_LIMIT_MS`, `RAINBOW_STORM_CHANCE`, `TABLE_SIZE`). Provide a committed `.env.example` with the non-secret defaults filled in and secrets left blank. `OPERATOR_PRIVATE_KEY` must never be committed.
5. Set up a CI/test entry point (a root `yarn test` and `yarn lint`) that runs across workspaces. The lint step includes a **stub** of the trademark check (the real grep logic lands in sub-spec 06 / T14) — for now it can be a no-op script that exists and exits 0, so the pipeline shape is in place.
6. Add a root `README.md` pointing at the specs folder and describing how to run each workspace.

## Out of scope (explicitly punt to later specs)
- The vendored engine source (that's sub-spec 02, T1).
- Any DB schema (sub-spec 04, T8).
- The Foundry project internals (sub-spec 05, T12 — though creating the empty `packages/contracts` folder is in scope here).
- The actual trademark grep logic (sub-spec 06, T14).

## Definition of Done
- [ ] `yarn install` from a clean checkout succeeds and links all five workspaces.
- [ ] `yarn workspaces info` lists engine, api, contracts, web, reference-agent.
- [ ] The config module loads and type-checks every §9 variable; a missing required var fails fast with a clear error.
- [ ] `.env.example` exists and is committed; `.env` is gitignored; `OPERATOR_PRIVATE_KEY` is not present in any committed file.
- [ ] `yarn lint` and `yarn test` both run to completion (even if they assert little yet) from a clean install.
- [ ] `.nvmrc` pins Node 24; the repo does not reference Node 20 anywhere.

## Handoff checklist to sub-spec 02
The next spec (Game Engine) will drop vendored source into `packages/engine/vendor/uno`. Before starting it, confirm: `packages/engine` exists as a valid TS workspace with its own test script, and the shared `tsconfig.json` is in place for it to extend.
