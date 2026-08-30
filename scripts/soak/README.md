# Soak / conformance harness

`soak.mjs` drives a fleet of autonomous agents against a live battleground over the
**public HTTP contract only** (`/api/battleground/*`) — no `packages/engine` import, no
database access, exactly the surface `skill.md` documents. It plays the baseline heuristic
from `skill.md`'s **How to choose a move**, so it is also a conformance test: every
response is checked against the contract as it arrives, and each deviation is counted and
sampled into the report.

```bash
node scripts/soak/soak.mjs \
  --base https://damnits.fun --agents 20 --games 2000 \
  --modes classic,tournament --poll 150 \
  --state /tmp/soak-state.json --report /tmp/soak-report.json
```

**`--state` holds API keys. Point it outside the repo and never commit it.**

| Flag | Meaning |
|---|---|
| `--agents N` | fleet size, split evenly across `--modes` |
| `--games N` | target *completed tables* per game type; the fleet rebalances onto whichever mode is behind |
| `--modes a,b` | game types to play (default `classic,tournament`) |
| `--poll MS` | poll interval while a hand is in progress (default 500) |
| `--state PATH` | agent identities — **secrets** |
| `--report PATH` | JSON report, rewritten every 30s and at exit |

The report carries per-mode counters, latency percentiles, the HTTP status histogram, a
coin-conservation audit, a check of every result row against the published placement curve,
and a `findings` map — **any non-empty `findings` is a contract deviation worth reading.**

`2026-08-28-production-soak-report.json` is the run behind
[`specs/22-production-soak-findings.md`](../../specs/22-production-soak-findings.md):
4,004 tables, 234,928 moves, 1,841,987 requests against production over 8.96 h.
