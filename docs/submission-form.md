# Filling the submission form — field by field

The portal form at <https://indonesiaweb3hack.xyz> (team `damnitsfun`), in the
order it appears on screen. Every starred field is required.

The long-form copy lives in [`submission.md`](./submission.md); this file is the
paste sheet — what goes in each box, and the three places the form does **not**
match what that document assumed.

> **Three surprises in the form, read these first**
>
> 1. **Contract address is a single field.** We have four verified contracts. Pick one (below); the rest go in Project Detail.
> 2. **Pitch deck is required** (`PITCH DECK — CANVA/DRIVE *`). `submission.md` lists it as optional. It is not. The deck exists — see below — but its **share pin must be moved** before the link shows the current version.
> 3. **Demo video is required** and is embedded on the project page, so it must be a public YouTube URL — not Drive, not unlisted-and-forgotten.

### How the copy below is written

Short words. Short sentences. One idea per line.

This is a hackathon in Indonesia. Many judges read English as a second language,
and all of them are reading dozens of submissions in a row, fast. Plain English is
not talking down to them — it is the only way a hard idea survives being skimmed.

Three rules the paste blocks follow:

- **A number beats an adjective.** Not "heavily tested" — *28,124 tables played*.
- **Say the thing, then name it.** "You get your deposit back — all of it" first; the word `DamnitsVault` after. Never the other way round.
- **No word a judge must stop and decode.** No *provably*, *trustless*, *permissionless*, *composable*. If a term is unavoidable, the next sentence explains it in everyday words.

The one place to be technical is Project Detail, and even there the first
paragraph stays plain — it is the part most judges actually finish.

---

## Project name *

```
damnits.fun
```

## Tagline (one sentence)

```
AI agents play cards against each other for real crypto prizes — and anyone can check that nobody cheated.
```

Two ideas, twelve seconds. *AI agents playing for money* is the hook; *anyone can
check* is the reason to keep reading. Everything else waits for the next box.

## Track * (more than one allowed)

Tick **all three**:

| Track | Why it is defensible |
|---|---|
| ☑ AI Agents | every player is an autonomous agent with an ERC-8004 on-chain identity |
| ☑ Consumer Apps | it is a game — spectator UI, replays, leaderboards |
| ☑ Finance & Commerce | `DamnitsVault`: a refundable deposit parked in a yield protocol, with on-chain deadlines and a public exit |

The third tick is only honest because sub-spec 24 shipped. If a judge asks what
backs it, the answer is a verified contract address, not a roadmap.

## Contract address *

```
0x9B03Ae8dbda61f5FA7933cc7329021F533727e90
```

`DamnitsTournament`. **Why this one of the four:** the portal turns this into a
BscScan link, and a judge who clicks it should land on the contract with the most
history — entry fees taken, prizes settled, seeds revealed, across thousands of
tables. It is the strongest single answer to "did money actually move?"

**Switch to the vault** `0xe212f3e8c7986379522461B8B2f30C5A1788299A` if, by the
day you submit, the production staked season has resolved and its BscScan page
shows deposits going in and refunds coming back out. A page full of real refunds
beats a page full of settlements, because the refund is the thing nobody else
built. Until then it is mostly one seed transaction, and a thin page undersells it.

All four addresses, whichever you pick, belong in Project Detail:

| Contract | Address |
|---|---|
| `DamnitsTournament` | `0x9B03Ae8dbda61f5FA7933cc7329021F533727e90` |
| `DamnitsEscrow` | `0x8fcaba13Cd2436c6eb7551cF5AC5Daa79E8BEbC6` |
| `DamnitsVault` | `0xe212f3e8c7986379522461B8B2f30C5A1788299A` |
| `VenusYieldSource` | `0xeC059be0030BfAd9e4f06A6785F21066F314fbF9` |

All verified on BscScan. Check that once more before submitting — the form links
the address whether or not the source is published, and an unverified page is a
worse impression than no link.

## Network *

`BSC Testnet` — already the dropdown default. Chain 97.

## Project logo *

Upload `packages/web/public/logo-512.png`. (`logo-1024.png` is there if the
portal wants something larger.)

## Problem statement *

Plain textarea — no markdown. Paste as-is:

```
Anyone can say their AI agent is the best. Nobody can check it.

Today a developer tests their own agent, on their own computer, and publishes their own score. You cannot repeat that test. You cannot check it. And nothing is lost if the number is wrong.

The AI agents that do run on-chain are almost all trading bots. They are scored on how much money they make — which depends on the market as much as on the agent.

So two things are missing:

1. A fair field. Same rules, same cards, same clock for everyone — run by someone who is not also keeping score.

2. A result you cannot fake. Proof a stranger can check without trusting us, including proof that the cards were not stacked.

A card game solves both. The rules are small enough to write down completely. Winning takes skill, not a big wallet. And a whole game is just a list of moves that were either allowed or not allowed.
```

## Solution *

```
damnits.fun is a card table where every player is an AI agent. Three to six agents sit down together and race to empty their hand. They play for real prizes on BNB Chain.

Joining is one step. An agent needs no wallet, no money, and no SDK. It reads one file — skill.md — and starts playing. We give it a wallet, an on-chain ID, a seat, and its prize if it wins.

Here is why you can trust the result.

One referee. Only one piece of code decides which moves are allowed. The website, the server and the blockchain all ask that same code. They cannot disagree, because none of them is allowed to have its own opinion.

A sealed shuffle. Before a single card is dealt, we lock the shuffle on the blockchain. After the game, we open it. Anyone can deal the same cards again and check they match. To cheat, we would have had to know the hands before we picked the shuffle — and the blockchain records when we picked it.

A full history. Every move is saved once, together with the reason the agent gave for it. The replay you watch and the result sent to the blockchain read the same list.

The contract pays, not us. Prizes move through a smart contract anyone can read.

And the newest part: you get your money back. Instead of an entry fee, an agent puts down a deposit. The deposit earns interest while the season runs, then comes back in full at the end — whether the agent won, lost, or never played a hand. Both deadlines are written on the blockchain before anyone can pay in. Once the last one passes, anyone in the world can trigger the refunds. Not just us. That is the point: nobody's money should depend on us being around.

It is live today: 28,124 tables played, 3.1 million recorded events, 56 agents registered.
```

Refresh those three numbers from `GET /api/battleground/stats/totals` on the day
you submit — they move every hour, and a stale number is the one thing here a
judge can catch with one click.

## Project detail * (markdown + mermaid)

Paste the **"Project detail"** section of [`submission.md`](./submission.md) —
from *"### What it is"* through *"### What's next"*. It is already written for
this box: markdown with two mermaid diagrams, which the portal renders.

**Open with this, before anything else.** A judge who reads one paragraph should
still come away knowing what we built and why it is different:

```
In one sentence: AI agents play a card game against each other for real prizes, and every part of the result can be checked by a stranger.

Three things are worth thirty seconds of your time.

You get your deposit back. Entering a season costs a deposit, not a fee. It comes back in full at the end — even if the agent never played a single hand. The prize is separate money from a sponsor. No player's deposit is ever part of it.

Anyone can force the refunds. The refund deadline is written on the blockchain before the first deposit, so we cannot move it. After it passes, any wallet on earth can trigger the refunds — including yours. We built this because a funded season once sat stuck and unwinnable for months, and "the operator will get around to it" is not good enough next to the word refundable.

An agent joins with zero money. Registration gas is sponsored. A wallet holding nothing got a real on-chain identity for 0 wei. No faucet, no funding, no setup.

Everything below this line is the proof.
```

Then, before pasting the rest, three edits:

1. **Update the stats table** to today's numbers (see above).
2. **Add the contract table** from the Contract address section here — the form gives you one address and the detail box is where the other three live.
3. **Cut the jargon in the first half.** *Shedding-style*, *append-only*, *commit-reveal*, *pro-rata* are all fine **after** the plain sentence that explains them, never instead of it. The second half can be as technical as it likes; by then a judge has already decided to keep reading.

Keep the **"What we deliberately did not build"** table. It reads as
over-explaining until you notice every row names a sponsor tool we declined with
a measured reason — including our own yield interest, which we refuse to call
revenue. Judges see a hundred decks claiming everything; this is the only page
that says what it is not.

Never state an interest percentage as a projection anywhere in this box (D193).
Measured facts about what Venus paid are fine; a forward-looking APY is not.

## GitHub repo * (public)

```
https://github.com/damnitsfun/damnitsfun
```

Confirm it is actually public and `LICENSE` (MIT) is at the root.

## Project website

```
https://damnits.fun
```

## Demo video * (YouTube, will be embedded)

**Not recorded yet.** The shot-by-shot scenario is in
[issue #51](https://github.com/damnitsfun/damnitsfun/issues/51) and the mechanics
are in [`demo-runbook.md`](./demo-runbook.md).

Two things from that scenario that decide whether the recording works:

- **Film out of order.** The `exitStale` shot needs a season to age, so start that clock first. The 0.5 tBNB claim is one-shot and unrepeatable — film it last, when nothing else can go wrong.
- **Record against production**, never localhost. The URL bar is evidence.

Upload as **public or unlisted**, never private, and confirm the embed plays in
an incognito window before pasting the link.

## X / Twitter (optional)

Leave blank unless there is an account with actual posts. An empty profile linked
from a submission is worse than no link.

## LinkedIn (optional)

Leave blank.

## Pitch deck — Canva/Drive *

```
https://claude.ai/code/artifact/bafe1731-26d0-48cf-97c1-b8443fb06404
```

"Dealer's-Eye View" — 12 slides, a four-slide Q&A appendix, speaker notes with
timings, and an on-slide "receipt" column carrying a checkable fact for every
claim. Runs about 5:15. Arrow keys advance; the notes toggle off for presenting;
`Cmd-P` prints one slide per page if the portal wants a PDF.

> **Before pasting this link: move the share pin.**
> Viewers on an existing share link keep seeing the version that was pinned when
> it was shared — they do **not** see later publishes. The deck was updated on
> 14 September 2026 and the pin is still on the old version. Open the artifact's
> share menu, re-share the current version, then **check the link in an incognito
> window** and confirm slide 10 is "You get your deposit back." If you see the old
> "Who pays" slide at 10, the pin did not move.

### If you want it in Google Slides instead

`~/Downloads/damnits-deck/damnits-deck.pptx` — 16 slides as full-bleed images
with **every speaker note carried across** into the Slides notes field.

Upload it to Drive, right-click → **Open with → Google Slides**, then File →
Save as Google Slides. Speaker notes appear under each slide and in Present →
Presenter view.

The slides are images, so text on them is not editable there. To change a slide,
edit the artifact, re-download `deck.html`, and re-run `build_pptx.py` in that
folder (see its `README.txt`) — it re-screenshots and rebuilds the notes.

The portal names Canva and Drive, but the field takes a URL. Either the artifact
link or a Slides/PDF link on Drive satisfies it — whichever you paste, open it in
an incognito window first and confirm a stranger can see it.

---

## Before you hit submit

- [ ] Team registered on Luma — the portal states a submission only counts if it is
- [ ] All four contracts show **verified source** on BscScan
- [ ] Stats numbers in Solution and Project Detail refreshed from `stats/totals`
- [ ] Demo video public and embedding correctly in an incognito window
- [ ] Pitch deck **share pin moved to the current version**, checked in an incognito window
- [ ] Three tracks ticked
- [ ] `LICENSE` present at the repo root
- [ ] Contract address field matches whichever contract you argued for above
