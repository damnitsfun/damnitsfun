# Sub-Spec 17 — Card-game visual identity (commit to the felt world)

**Status:** not built (spec only). Sub-spec 16 made the product *behave* like a broadcast; it still *looks* like a
developer console wearing one dark rectangle. This spec gives damnits a card-game visual identity of its own:
its own palette, its own centre motif, a display typeface beside the mono, and a ground that commits to the felt
instead of a white page. The goal is stated plainly: **be the only thing in the category that looks like an
actual game**, rather than a better-executed terminal.

**Silo(s):** `packages/web` (`home.html`, `index.html`) + **one static font asset** + docs.
**No API, engine, contract, schema, or money-movement change.**
**Depends on:** 16 (motion layer, agent faces, hero replay — all load-bearing here), 12 (battleground naming and
the "arena" ban), 06 (trademark lint). Slots **after 16**.
**Handoff artifact:** a battleground and homepage that read as a card game within a second of loading, on their
own palette and motif, with no borrowed trade dress and the no-build-step constraint intact.

---

## Why this spec exists

Two things prompted it.

1. **The battleground is a white page.** `index.html` has **no `prefers-color-scheme` block at all** — its ground
   is a hard `#faf9f5`, and only the four `--felt-*` tokens are dark. Sub-spec 16 made the board darker and
   livelier, which raised the contrast against that white chrome and made it obvious. Bolting on a dark-mode
   block would still leave anyone on a light OS looking at a white game.
2. **Terminal is the category's default costume.** dev.fun's arena, the agent leaderboards, most crypto
   dashboards — mono, hairlines, tables. Out-executing that look wins nothing, because it is what everyone else
   is already wearing.

### The finding that unblocks this

The obvious way to look like a card game collides with global rule #2 (never imitate the vendored game's trade
dress). It turns out that collision is much smaller than it appears.

Trade dress protects a **distinctive combination** of *non-functional* elements; functional elements are
explicitly outside it, and a single colour is not protectable alone. Filtered through that, nearly everything
that produces the feeling is free:

| Element | Status | Why |
|---|---|---|
| Colour as the matching axis | **free** | It is the game mechanic — colour replaces suit. Mechanics are not dress. |
| Large centre glyph | **free** | Functional legibility; universal to card games. |
| Corner indices | **free** | Functional — what makes a value readable while cards overlap in a fan. |
| Effect printed on the face (`+2`, `+4`, arrows) | **free** | Functional description of a rule. |
| Rounded corners, white border | **free** | Generic to physical playing cards. |
| The white ellipse at 45° with an outlined numeral | **NOT free** | The distinctive non-functional mark — and it does no work the glyph isn't already doing. |
| Their exact hue set combined with wordmark and ellipse | **NOT free** | Individually unremarkable; as a combination it is the recognisable dress. |

> **The line, in one sentence:** the grammar is free, the specific combination is not — so take the whole grammar
> and build a different combination.

### What "not terminal" actually requires

From the design research (recorded here so the reasoning outlives the branch):

- **Pick an aesthetic your constraints enable, then commit completely.** Balatro's CRT look came from solo-dev
  limits, not taste; its power is that *every* element obeys it. Our constraint is no build step and no asset
  pipeline — so a CSS-native card world is the identity, if we commit everywhere rather than on one panel.
- **Colour is the label.** Assign meaning per colour and legends stop being necessary. damnits already has four
  colours doing real work in the rules; the interface should let them do that work everywhere.
- **Feedback is a five-channel stack.** Element animation, state colour, number rolling, proportional shake,
  audio. Sub-spec 16 shipped the first two. Layers 3 and 4 are cheap and missing.
- **Exaggerated hierarchy** — very large numbers against very small labels — is the current differentiator from
  both AI-minimalism and terminal uniformity. One 13px mono size for everything is the opposite of it.

---

## Design decisions locked for this spec

| # | Decision | Chosen | Alternative (not built) |
|---|---|---|---|
| D86 | Take the grammar, not the dress | Adopt every **functional** convention in the table above; adopt **none** of the distinctive combination. The centre motif, hues and type are ours. | Copying the familiar look outright; or avoiding card conventions entirely out of caution — which is what left the product looking like a dashboard |
| D87 | Centre motif is a **corner wedge** | Two opposed corner triangles behind the glyph. Deliberately **not an ellipse**. Chosen over a diagonal band and an arc: most distinctive of the three, echoes the four-colour split already used for any-colour cards, and stays legible at the 36px face the replay renders. | The diagonal band shipped in 16 (kept as fallback); an arc; an ellipse (forbidden) |
| D88 | Our own four hues | `red #e0503c · yellow #f2b826 · green #46b169 · blue #3f86d6` — shifted from both the famous set and today's muted tokens: enough to be ours, saturated enough to read as a game on felt. | Reusing the current `#c2503f/#c99a25/#3d8552/#3a6ea8` (too muted on felt); matching the famous set (the combination is the risk) |
| D89 | Gold means money, and only money | `#ffcf4d` is reserved for coins, pots, jackpots and wins. It is never a playing colour, so value never competes with the four card colours. | Using yellow for both a card colour and currency — which makes the leaderboard and the deck fight each other |
| D90 | The battleground commits to felt; the homepage stays adaptive | `index.html` becomes **felt-dark, single-theme** — it is the game surface, and a game surface should not be white. `home.html` keeps its `prefers-color-scheme` behaviour: it is the front door, and a lit table on paper reads as a stage. | Adding a dark-mode block to `index.html` (leaves light-OS visitors on a white game); darkening both (loses the front-door contrast) |
| D91 | Display typeface as a **self-hosted static asset** | One variable `.woff2` (~30–60KB) in `packages/web/public`, loaded with `@font-face`, with a system stack fallback (`Futura`/`Avenir Next`/`Trebuchet MS`/`system-ui`). **Never a font CDN** — that is a live network dependency that can fail in front of a judge. | A Google Fonts `<link>` (demo risk); base64-inlining (bloats both files); system-only (workable, but no ownable voice) |
| D92 | A static asset is not a build step | The stack pin bans a **build step and a second toolchain**, not files. One font served from the existing static directory adds no tooling, no bundler and no install. Recorded explicitly so nobody reads it as a violation later. | Treating "single-file" literally and shipping no typeface |
| D93 | Colour never carries meaning alone | Every card keeps its glyph and corner indices; every state keeps a shape or label as well as a hue. ~4.5% of people are colourblind, and the four-colour system is the one place this could go wrong. | Relying on the hue alone now that the palette is louder |
| D94 | Juice layers 3 and 4 | Add **number rolling** (staggered per-digit, slot-reel) and **proportional shake** (magnitude as a data channel) on top of 16's motion layer, reusing its budget and kill switch. Audio stays deferred — **D79 stands unchanged**. | Adding audio now; adding particles (more code, less signal) |
| D95 | This closes 16's T57 deviation | D78's `felt`/`terminal` scopes get formalised in the token block here. D78 itself is **not** superseded — it was right, it was only half-applied. | Re-litigating D78; leaving the deviation open indefinitely |
| D96 | The display face is **Archivo Variable** | One OFL variable `.woff2` (weight 100–900), **subset to Latin basic** before shipping — a full charset runs 100KB+. Chosen on **numerals first**: this is a numbers product (card values, coins, decision times), so the face must be unmistakable at a 36px card glyph *and* an 80px headline, with real `tabular-nums`. Archivo's figures hold at both, it goes genuinely heavy for exaggerated hierarchy, and its width axis leaves room for condensed scoreboard numbers later. Subsetting is a one-time offline step producing a static file, so D92 still holds. | **Inter / Space Grotesk** — both excellent and both the current default-safe picks, which is precisely why they'd make a project trying to stand out look generic. A pure geometric (ambiguous `1` at card sizes). A display-only face (no usable weight range) |
| D97 | The card **back** is a designed surface, not filler | The back echoes the D87 wedge so face and back read as one deck. It is the **most-repeated graphic on screen** — opponents' hands are face-down, roughly 5–7 backs × 3 opponents — and the only surface with *no* functional constraint and *zero* trade dress exposure. Free, ownable identity; it belongs in T59, not in a later pass. | Leaving the placeholder woven pattern from 16; deferring it as a nice-to-have (the original draft of this spec — wrong, see the rationale above) |

> **Why D90 is worth the words.** "Make it dark" sounds like taste. It isn't: the battleground is the surface a
> judge lands on to watch a game, and it currently renders a white page with one dark rectangle in the middle.
> Committing the ground is what makes the felt read as a table rather than as a widget.

---

## Scope & task order

**T58 — Tokens and ground (do this first).** Introduce the D88/D89 palette and formalise the `felt` / `terminal`
scopes (D95). Flip `index.html` to a felt-dark single-theme ground (D90); leave `home.html` adaptive. Biggest
change in how the product reads, lowest risk, and everything after it inherits the result.
*DoD: `index.html` renders felt-dark under **both** OS themes — verified by computed style, not screenshots; the
homepage still resolves in light and dark; contrast on text and on every card colour is checked, not assumed.*

**T59 — The card motif, face and back.** Apply the corner wedge (D87) to both surfaces' card faces, keeping the
glyph, corner indices and `title` from earlier specs. Design the **back** in the same family (D97), replacing the
placeholder woven pattern from 16.
*DoD: cards read correctly at 36px (replay hand), 54px (discard) and 92px (homepage diagram); the back is
recognisably the same deck as the face and holds up repeated 5–7 times per opponent; no ellipse anywhere;
trademark lint green.*

**T60 — Typeface and hierarchy.** Add the display face (D91/D92/D96) with its fallback stack; apply exaggerated
hierarchy — big on scores, card faces, headlines and stakes; mono retained for agent ids, event log, hashes and
the onboarding command.
*DoD: the page renders correctly with the font file **absent** (fallback stack proves out); no external font
request is made; the onboarding block is untouched.*

**T61 — Juice layers 3 and 4.** Number rolling for coins/pots/jackpot; proportional shake on wins and storms.
Both route through 16's motion helper so the budget, cancellation and `prefers-reduced-motion` guarantees apply
unchanged.
*DoD: a settling table visibly rolls its coin totals; shake magnitude differs between a small and a large win;
reduced motion yields the final numbers instantly with no movement.*

**T62 — Sweep for consistency.** The identity has to hold on *every* surface — standings, profile, rules, modals,
empty states, error states — or it reads as a filter rather than an identity.
*DoD: no surface still renders the old palette or the old ground; a reader can tell felt surfaces from terminal
surfaces at a glance.*

---

## Guardrails

- **No ellipse, ever** (D86/D87), and no imitation of the vendored game's card back, wordmark or hue set.
- **The nominative-use carve-out is unchanged** — user-facing copy only, disclaimer required. This spec adds no
  new nominative uses.
- **"arena" stays banned** in `packages/web` (D85, enforced by `battleground-e2e`). The game scope is `felt`.
- **No font CDN, no bundler, no new dependency** (D91/D92).
- **Reduced motion and the 320ms budget still bind** — layers 3 and 4 are additions to 16's helper, not
  exceptions to it.
- **Demo reliability beats polish.** Anything that could stall or obscure state during a live demo is cut.

## Safety boundary
- Presentation-only. No new endpoints, no schema change, no contract change, no new secrets, no change to what
  data is public. Replay-only (spec 10) is untouched.
- The one new artefact is a static font file served from the existing public directory — no install step, no
  third-party request at runtime.

## New / changed config (§9)
None.

## Definition of Done
- [ ] `index.html` is felt-dark under both OS themes (computed-style check, not a screenshot); `home.html` still
      resolves in both.
- [ ] D88 palette applied; gold appears only on money; contrast verified on text and on all four card colours.
- [ ] Corner wedge applied at every card size; the card **back** shares the family; no ellipse; trademark lint green.
- [ ] Archivo Variable (subset) loads from the local asset, falls back cleanly when absent, and makes **no**
      external request. Numerals verified at 36px and at headline size.
- [ ] Coin/pot figures roll; shake scales with magnitude; `prefers-reduced-motion` still yields a static, complete page.
- [ ] Standings, profile, rules, modals, empty and error states all carry the identity.
- [ ] `felt`/`terminal` scopes formalised — **closes sub-spec 16's T57 deviation**.
- [ ] Full api suite + trademark lint green; no new dependency in any `package.json`.

## Open questions / deferred

**None.** The three the first draft carried are all resolved, deliberately — every open question in a spec about
to be built is a decision someone would otherwise have to improvise mid-implementation.

- *Which display face* → decided (D96). Cheap to reverse if the numerals disappoint: one file, one token.
- *A card back design* → pulled into T59 (D97). The first draft deferred it as a nice-to-have; that was wrong.
  It is the most-repeated graphic on screen and the only surface with no functional constraint and no trade
  dress exposure — the cheapest identity in the product.
- *Audio* → **out of scope for this cycle**, not "deferred pending review". D79 is unchanged and still describes
  the shape if it is ever built. The reasoning for closing it rather than carrying it: autoplay policy keeps the
  hero silent regardless, so audio only ever reaches someone who already pressed play on the replay; silence
  costs nothing because no one expects sound from a web app, while a mistimed sting on a shared screen costs a
  lot; and the same hours spent on T62 reach every judge. Worth revisiting only for a public launch, where feel
  drives retention — a different product moment than a four-minute judging pass.

---

### Index & FR housekeeping
- Add to `specs/00-INDEX-and-build-order.md`:
  `| 17 | Card-game visual identity — own palette and centre motif, felt-dark battleground, a display face beside the mono, juice layers 3–4 *(presentation-only; closes 16's T57 deviation)* | \`web\` | T58–T62 | 06, 12, 16 |`
- Supersedes nothing. It **completes** 16's D78 (via D95) and leaves D79 (no audio) standing.
- When this lands, add a forward pointer on sub-spec 16's T57 deviation so a reader sees it was completed here
  rather than abandoned.
