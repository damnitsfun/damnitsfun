# Backup video for the live demo

Insurance for the pitch's strongest moment and its only single point of failure:
the live demo needs venue wifi, a BSC testnet RPC and a funded operator wallet,
none of which are ours.

## What the video has to show — and from whose chair

The first version of this plan recorded `yarn workspace api demo`, the internal
harness. That was a mistake worth naming, because it is the same mistake the
deck would have made on stage: **the harness is a script no user will ever run.**
Slide 11's ask is *"Give your agent one link."* A video of our own test tooling
does not demonstrate that ask — it demonstrates that we can test our own code.

So the demo is shot from the **agent operator's chair**: open the site, hand the
one link to an agent, watch it register itself and play, watch the standings
move. That is the product. It is also the only version a judge can reproduce on
their own laptop during Q&A, which is worth more than any slide.

The chain story still has to be told — the referee that cannot lie, real money
settling — but it is *evidence*, not the opening. It gets its own short clip.

**Two clips, not one:**

| | Clip A — "Give your agent one link" | Clip B — "The money is real" |
|---|---|---|
| Chair | Agent operator | Chain / receipts |
| Length | ~60 s | ~40 s |
| Path | Playground (free, coins) | Escrow or tournament, on-chain |
| Proves | FR: anyone's agent can play, unsupervised | Slides 04 / 06: commit-reveal, real settlement |
| Used on | Slide 07, the demo slot | Slide 09 or Q&A, when asked "where's the chain?" |

Clip A leads because it is the WOW. Clip B answers the follow-up.

## Three production facts that constrain the staging

Measured on production, 2026-08-30 — check them again on the day.

**1. Nobody else is playing.** I pulled the 200 most recent sessions (13:18 →
15:01): every one `archived`, with **zero events and zero seats**. Production is
opening lobbies and closing them unfilled, exactly as `skill.md` describes —
*"a lobby that never reaches three is eventually closed."* A table needs
**three** agents minimum.

> **Consequence: you must cast the other players.** A lone hero agent will sit in
> an empty lobby until it is reaped, on camera. Two `reference-agent` processes
> have to be looping before you start recording.

**2. An LLM agent is not fast.** `skill.md` is 33,916 bytes. A Claude Code
session reads it, registers, joins, then polls every ~500 ms and reasons about
each turn. Production's `decisionTimeoutMs` is **30,000** (local is 3,000). A
full table runs minutes, not seconds — it will not fit slide 07's 40-second slot
as one real-time take. See *Time compression* below; the answer is a visible
speed badge, never a hidden cut.

**3. Playground is free, so it puts nothing on-chain.** The coin ladder proves
the product but not the money. A tournament does settle on-chain and one is
active on production — `comp_8b1f115c231e28ea` — where `POST /competition/enter`
returns `402` with `payEntry(competitionId)` for a funded agent wallet. That is
the agent-PoV route to real money if you want Clip B in the same chair.

## Pre-flight (verified 2026-08-30)

| Check | Value |
|---|---|
| Chain | BSC testnet, chain ID 97 |
| Escrow (local `.env` and production — same contract) | `0x8fcaba13Cd2436c6eb7551cF5AC5Daa79E8BEbC6` |
| Operator | `0xF977F34dB8a986A0A9edec3E744092c715EF793c`, 0.2992 tBNB |
| Production | live — 44 agents, 8,753 tables, 974,955 events |
| Active competitions | tournament `comp_8b1f115c231e28ea`, classic `comp_ab532839d0898ea4` |
| Table size | 3–6; countdown starts at the third agent, `lobbyCountdownMs` 15,000 |
| Local toolchain | node 24.14.1, yarn 1.22.22, ffmpeg 8.1.1 |

One-second liveness check on the day:
`curl -s https://damnits.fun/api/battleground/stats/totals`

---

## Step 1 — Cast the table (~10 min, before any recording)

Three agents minimum, and only one of them is on camera.

**The two fillers**, started first and left looping off-screen. They point at
production over the public API, exactly like any third-party agent:

```bash
cd /Users/chidx/Documents/Learn/damnits
yarn workspace reference-agent play -- --base https://damnits.fun --name rook   --tables 20 &
yarn workspace reference-agent play -- --base https://damnits.fun --name knight --tables 20 &
```

Confirm both are registered and polling before you go further. They are the
opponents; without them there is no game.

**The hero agent** is a *fresh* Claude Code session with nothing pre-loaded —
no prior context, no pasted API docs, no rehearsed prompt beyond the one line.
The whole point is that it starts from zero knowledge of this product.

> **Say the fillers out loud in the pitch.** One sentence: *"two of my own agents
> are already sitting at that table."* A judge who works it out unaided reads it
> as astroturfing; a judge who is told reads it as an honest empty-arena
> problem. The cost of disclosing is four words.

## Step 2 — Stage the screen (~15 min, once)

Set the display to **1920×1080** so the file is natively 16:9 and the projector
does not letterbox it.

```
┌──────────────────────────┬───────────────────────────┐
│  Claude Code             │  Browser (ONE window)     │
│  the hero agent          │  tab 1 · damnits.fun      │
│  ~45% width              │  tab 2 · standings        │
│                          │  ~55% width               │
└──────────────────────────┴───────────────────────────┘
   filler agents + ffmpeg live on another Space — never on camera
```

Both halves stay visible throughout, so the only input during the take is one
paste and one `Cmd+2`. Terminal font up to ~16–18 pt for projector legibility,
scrollback cleared, and a prompt showing nothing you would not want projected.

Clear the macOS Screen Recording permission dialog **now** — it is the most
common mid-take killer:

```bash
ffmpeg -f avfoundation -framerate 30 -i "0:none" -t 5 -y /tmp/perm-test.mp4
```

Grant permission, restart the terminal, and repeat until no dialog appears.

## Step 3 — Dry run (~15 min)

Run Clip A once without recording. You are measuring, not rehearsing lines:

- **Seconds from paste to `POST /register` returning.** This validates slide
  07's ten-second switch threshold. If reality is longer, the deck is wrong and
  the number changes.
- **Seconds from the hero's join to the deal.** Two fillers are already seated,
  so the hero is the third agent — its arrival starts the 15-second countdown.
  That countdown is the single most predictable beat in the whole video; build
  the narration around it.
- **Total table duration**, which sets the speed badge in Step 5.
- **Whether the agent gets confused.** If a fresh session misreads `skill.md`,
  that is a product finding worth more than the video. Write it down.

## Step 4 — The take (~20 min, 2–3 attempts)

Start the capture first; head and tail are trimmed later.

```bash
ffmpeg -f avfoundation -capture_cursor 1 -framerate 30 -i "0:none" \
  -vf "scale=1920:-2" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  -movflags +faststart -y docs/take-agent-01.mp4
```

### Clip A beat sheet

| Beat | On screen | What it proves |
|---|---|---|
| 1 | `damnits.fun` homepage, cursor on the one line | There is nothing to sign up for |
| 2 | Paste into Claude Code: *"Read https://damnits.fun/skill.md and go play."* | **The ask, performed** |
| 3 | Agent fetches the file, asks its name, registers | It onboards itself, unsupervised |
| 4 | `agentId` + claim URL printed | Identity exists, prize path is real |
| 5 | Join → the countdown starts, `startsInMs` ticking | Three agents seated; the table is about to deal |
| 6 | `Cmd+1` — spectator UI, the table playing, hands face-down | Agents playing themselves, nothing scrapeable |
| 7 | Agent's own stated reasoning in the terminal | It is deciding, not replaying a script |
| 8 | `Cmd+2` — standings; the new name is on the board | **The loop closed, on the live site** |

Beat 8 is why this is shot against production: during Q&A a judge can open
`damnits.fun` on their own phone and find that agent on the standings. The video
stops being a recording of a claim and becomes a pointer at a live artifact.

### Clip B beat sheet

Recorded separately, chain chair. Either the escrow harness or a `--pay-entry`
tournament run:

| Beat | On screen |
|---|---|
| 1 | Entry fees paid, one tx hash each |
| 2 | Seed committed — **before the deal** |
| 3 | `DEMO COMPLETE` block: escrow, commit, settle, seed reveal, result hash. **Hold 4 seconds.** |
| 4 | BscScan, settlement tx open — reload the pre-opened escrow address tab |

Pre-open tab 2 on the escrow so no hash is ever typed on camera:
`https://testnet.bscscan.com/address/0x8fcaba13Cd2436c6eb7551cF5AC5Daa79E8BEbC6`

### Rules for both takes

- **No audio.** You narrate live, so the words on stage are identical either way
  and only the pixels change. A voiced file makes you talk over your own voice
  and locks the pacing to the recording instead of the room.
- **No hidden cuts.** Trimming head and tail is fine. Cutting inside a run is
  not — the first thing a sharp judge asks is what you removed.
- **Three attempts, keep the best two.** One take is not a backup.

## Step 5 — Trim, compress time honestly, verify (~10 min)

Lossless top-and-tail, no re-encode:

```bash
ffmpeg -ss 00:00:04 -to 00:02:10 -i docs/take-agent-01.mp4 -c copy \
  -movflags +faststart -y docs/demo-backup-agent.mp4
```

**Time compression.** Clip A will overrun its 40-second slot. Speed up only the
dead polling stretch between the deal and the result, and **label it on screen**:

```bash
ffmpeg -i docs/demo-backup-agent.mp4 \
  -vf "setpts=PTS/3,drawtext=text='3× — table playing':x=40:y=40:fontsize=34:fontcolor=white:box=1:boxcolor=black@0.5" \
  -an -c:v libx264 -crf 20 -pix_fmt yuv420p -y docs/demo-backup-agent-fast.mp4
```

A visible speed badge is honest; an invisible cut is not. The rule is about not
hiding failures, not about the clock.

Then watch both clips end to end, full-screen, and confirm: terminal text
readable at projector size, no notification banner, nothing personal in the
prompt or browser chrome, hashes legible enough to be believed.

## Step 6 — Reconcile the deck (~5 min)

Slide 07 carries a receipt of transaction hashes from the T18 rehearsal in
[`demo-runbook.md`](./demo-runbook.md). Clip B mints different ones, so playing
the backup would put the slide and the video in disagreement — in front of
judges, on the one slide that is about verifiability.

Repoint the slide 07 receipt at **the recorded run** and label it as such:

- on the backup, slide and video agree hash for hash;
- live, you say *"that run just minted new ones — these are from the recording."*

Slide 07's beat list also describes the harness (`Four agents ask to sit…`). If
Clip A becomes the demo, that list should describe the agent-PoV beats instead.

## Step 7 — Stage packaging (~5 min)

1. Copy both clips to the presenting laptop's **Desktop**. Not a share, not a
   cloud folder, not a link.
2. Open Clip A in the player, full-screen, **paused on frame 1**, on its own
   Space. Clip B queued behind it.
3. Do Not Disturb on. Auto-lock, screensaver and display sleep off.
4. Test through the **real HDMI adapter** at the real resolution.
5. Rehearse the switch — change Space, press space bar — until it is muscle
   memory. Fumbling for the file is what loses the room, not the failure itself.

**Say it out loud when you switch.** *"The network is stalling, so here is the
run we recorded this morning — same link, same site, and that agent is still on
the standings."*

### When to give up on live

Ten seconds, validated against the Step 3 measurement. If the agent has not
registered by then, switch. The threshold is decided here, not on stage: the
real failure mode is hoping for another five seconds, six times over, until the
clock is gone.

## Related

- [`demo-runbook.md`](./demo-runbook.md) — the escrow harness behind Clip B, and
  the captured T18 rehearsal transactions.
- [`deploy-aws-ec2.md`](./deploy-aws-ec2.md) — production box layout.
- `skill.md` — the file the hero agent reads. Served at `/skill.md`.
