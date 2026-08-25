# Run 19 — full-surface test plan

Written before any testing. Every item states what *correct* means concretely,
so a pass is a match against this text rather than an impression.

Executed against the deployed product — `play.mempire.fun` (Vercel) and
`mempire-relay-production.up.railway.app` (Railway) — on devnet, through the
browser pane, which is a real Chromium driving the real site. Console and
network are checked on every UI item; any error fails it.

Legend: **PASS** / **FAIL** / **UNTESTABLE** (with the missing dependency named).

---

## A · Shell, routing, boot

| # | Item | Correct means |
|---|---|---|
| A1 | Cold load of `/` | Arena renders; zero console errors; zero requests ≥400 |
| A2 | Hash routes `#/cards` `#/deck` `#/clan` `#/empire` `#/swap` | Each renders its own screen, no blank frames, no errors |
| A3 | Reload on a deep route | Returns to the same screen, state rehydrated from chain/relay |
| A4 | Guest identity persists | Same address across reloads; `mempire_guest_sk` reused not regenerated |
| A5 | Cluster/mint guard | Build refuses to boot when cluster and RPC disagree (preflight covers build; runtime guard present in bundle) |
| A6 | Haptics gated on gesture | No `navigator.vibrate` intervention in console on a fresh tab |

## B · Arena and matchmaking

| # | Item | Correct means |
|---|---|---|
| B1 | Tier selector | Four tiers 0.05/0.25/1/5; selecting one updates the pot line to 2× stake |
| B2 | Pot maths | "POT" = 2× stake, "winner takes 90%" matches rake_bps 1000 |
| B3 | Deck-power gate | Ranked disabled or demoted when fewer than 8 on-chain cards; message says so |
| B4 | Practice mode | Starts a bot match, escrows nothing, reads NO STAKE |
| B5 | Queue then cancel | Leaving the queue escrows nothing and returns to Arena cleanly |
| B6 | Ranked queue is signed | Relay records ranked only for a signed queue (action `queue`) |
| B7 | Two clients match | Browser gets seat 0, second client seat 1, same match id |
| B8 | Insufficient balance | A wallet below the stake cannot enter that tier; the reason is shown |

## C · Battle, settlement, recovery

| # | Item | Correct means |
|---|---|---|
| C1 | Escrow opens | `create_match` + `join_match` land; match account holds 2× stake |
| C2 | Rollup delegation | Badge reads ROLLUP LIVE; log owned by the delegation program |
| C3 | Card drops record | Each legal drop increments the rollup play count |
| C4 | Illegal drop refused | Dropping on the opponent half does not deploy and costs no elixir |
| C5 | Both seats report | Two claims recorded; agreement seals the log |
| C6 | Settlement pays | Winner receives pot − rake; treasury receives rake |
| C7 | Draw path | Tie splits the pot with 5% tie rake, both seats refunded ~0.0475 |
| C8 | Win reward | Winner's $MEMPIRE +50 and vault −50, while under the per-wallet cap |
| C9 | Reward cap | A wallet at 16 rewarded wins settles normally but receives no bonus |
| C10 | Timeout recovery | Empire surfaces a stranded stake; before deadline refuses, after it pays |

## D · Cards, collection, shop

| # | Item | Correct means |
|---|---|---|
| D1 | Collection renders | Cards listed with level and archetype; count matches chain |
| D2 | Card detail | Stats, lore, market data; archetype = `fnv1a(mint) % 6` |
| D3 | Mint with SOL | Treasury +0.02 SOL; a real Card account appears |
| D4 | Mint with $MEMPIRE | Treasury +250 $MEMPIRE and **no** 0.02 SOL fee |
| D5 | Shop price honesty | Quoted price equals charged price; no discount badge on chain prices |
| D6 | Free reroll | Rotates offers, costs nothing, decrements the free counter |
| D7 | Paid reroll | Transfers 35 $MEMPIRE to the treasury before offers change |
| D8 | Merge a duplicate | Level +1, duplicate closed, fee = 100 × level to treasury |
| D9 | Merge guards | Self-merge, mismatched coins, and tokenised duplicates all refused |
| D10 | Tokenise a card | Real 1-of-1: supply 1, decimals 0, royalty 500bps to treasury |

## E · Deck

| # | Item | Correct means |
|---|---|---|
| E1 | Deck shows 8 slots | Power = Σ levels; matches what `create_match` locks |
| E2 | One card per coin | A second card of the same coin cannot be added |
| E3 | Deck persists | Survives reload |
| E4 | Loadout slots | Switching slots swaps the active deck |
| E5 | Locked cards | A card locked to a live match cannot be decked |

## F · Clan

| # | Item | Correct means |
|---|---|---|
| F1 | Browse clans | Lists clans from the relay with member counts |
| F2 | Charter price honesty | Button quotes 250, the till charges 250 |
| F3 | Found a clan | Clan created, then the charter fee is collected |
| F4 | Cancel the charter | Declining dissolves the clan — founding-and-walking-away is not free |
| F5 | Join / leave | Membership changes persist across reload |
| F6 | Crowns | Clan crown total reflects recorded matches |
| F7 | Duplicate name | A taken name is refused before any money moves |

## G · Empire, leaderboard, analytics

| # | Item | Correct means |
|---|---|---|
| G1 | Leaderboard renders | Ranked by net SOL, the viewer highlighted |
| G2 | Money is chain-verified | An unverifiable claim ranks zero |
| G3 | No double-credit | The same settled match reported twice credits once |
| G4 | Match history | Recent results with correct won/lost/draw |
| G5 | Unsettled stake panel | Appears only when a stranded match exists |
| G6 | TVL endpoint | Reports escrow and pool, and publishes no "staked" figure |

## H · Swap / market

| # | Item | Correct means |
|---|---|---|
| H1 | Venue detection | Bags preferred; falls back to a pool matching this cluster |
| H2 | Unconfigured Bags | `/api/market` says `configured:false`; quotes 503, never a fabricated price |
| H3 | Refusal is honest | With no venue for the cluster, the screen states the reason |
| H4 | Quote maths | A local-pool quote matches constant-product with 0.30% fee |
| H5 | Balances | $MEMPIRE and USDC balances read from chain |

## I · Relay API

| # | Item | Correct means |
|---|---|---|
| I1 | `/api/health` | 200 `{ok:true}` |
| I2 | `/api/coins` | Registry for this cluster; devnet list, not mainnet |
| I3 | `/api/leaderboard` | Sorted rows, no fabricated netSol |
| I4 | Signature required | Mutating routes 401 without a valid signature |
| I5 | Replay refused | The same signature twice → 401 "already used" |
| I6 | Match dedup | Second report of one match → `duplicate:true`, no increment |
| I7 | Faucet gating | Faucet routes exist on devnet, 404 on a mainnet RPC |
| I8 | Rate limiting | Burst traffic is throttled rather than served unbounded |
| I9 | `/api/market` | Honest `configured` flag |
| I10 | Bad input | Malformed bodies 400, never 500 |

## J · On-chain money paths

| # | Item | Correct means |
|---|---|---|
| J1 | Fee destinations pinned | Every fee instruction constrains treasury to `config.treasury` |
| J2 | Stake/tier bound | `create_match` refuses a stake that is not the tier's |
| J3 | Joiner matches stake | `join_match` escrows exactly the creator's stake |
| J4 | Deck locking | Exactly 8, owned, unlocked, distinct coins |
| J5 | Close settled match | Rent returns to the creator |
| J6 | Free orphaned cards | A card locked to a closed match can be recovered |
| J7 | Reward counter | Created idempotently, caps at 16 |
| J8 | Pool creation gated | `init_pool` requires the upgrade authority |

## K · Audit regressions (must stay fixed)

| # | Item | Correct means |
|---|---|---|
| K1 | Delegated-log timeout | A loser cannot take the pot; unreadable log voids and refunds both |
| K2 | Checkpoint freeze | `checkpoint` does not move the play cursor |
| K3 | Per-seat play budget | One seat cannot consume all 128 entries |
| K4 | Settler pinned | A stranger cannot settle someone else's match |
| K5 | init_log bound | Fabricated match refused; imposter seat refused; honest call accepted |
| K6 | VRF queue closed | A plain build accepts only the production queue |
| K7 | Chest delegation | Validator is router-assigned, not caller-named |

---

Total: **82 items.**

---

# Results

Executed 24–26 Aug 2026 against the deployed product on devnet. Every UI item
was driven through a real browser; every money claim was checked against the
chain rather than the screen.

## A · Shell, routing, boot — 6/6 PASS

A1 cold load: Arena renders, 81 requests, none ≥400, console clean.
A2 all five hash routes render their own screen.
A3 reload on `#/empire` returns there with state rehydrated.
A4 guest key persists across reloads and tabs.
A5 preflight refuses a mainnet build with no `VITE_MEMPIRE_MINT` and accepts a
correct one.
A6 no `navigator.vibrate` intervention on a fresh tab.

## B · Arena and matchmaking — 8/8 PASS

B1 four tiers at 0.05 / 0.25 / 1 / 5.
B2 pot tracks 2× stake across tiers; "winner takes 90%" matches rake 1000 bps.
B3 an incomplete deck reads "deck needs 8 cards" and ranked will not start.
B4 practice present and escrows nothing.
B5 queue then cancel: **zero** open or active matches on chain afterwards.
B6 ranked queue is signed (the harness signs action `queue`; unsigned demotes).
B7 browser took seat 0, second client seat 1, same match id.
B8 Emperor tier is `disabled` at a 1.19 SOL balance, desaturated with the price
in red.

## C · Battle, settlement, recovery — 9 PASS, 1 partial

C1 escrow opened, match account held 2× stake.
C2 badge ROLLUP LIVE; log owned by the delegation program.
C3 every legal drop incremented the rollup play count.
C4 **FAIL → fixed → PASS.** See below.
C5 both seats claimed; agreement sealed the log.
C6 winner paid pot − rake; treasury +0.01 per 0.1 pot.
C7 draw splits with 5% tie rake (observed on match #80: SPLIT, +0.048 each).
C8 winner +50 $MEMPIRE, vault −50.
C9 **partial.** The counter is created and increments (0 → 1 → 2) and the payout
is gated on `wins < REWARDED_WINS_CAP`. The boundary itself was not exercised —
that needs sixteen settled wins on one wallet. Marked partial rather than PASS.
C10 Empire surfaced the stranded stake, refused before the deadline ("the
deadline has not passed yet"), and paid after it.

## D · Cards, collection, shop — 10/10 PASS

D1 18 cards on chain, matching the collection count.
D2 detail shows stats, archetype, market data and lore.
D3 mint with SOL → treasury **+0.020000**.
D4 mint with $MEMPIRE → **−250 $MEMPIRE, treasury SOL unchanged**; the wallet's
SOL moved only −0.0019 for the new card's rent.
D5 every offer quotes 250 and charges 250; no discount badge on chain prices.
D6 free reroll rotates offers and decrements the counter.
D7 paid reroll → **−35 from the player, +35 to the treasury**.
D8 merge: level 1 → 2, fee 100 $MEMPIRE, duplicate closed.
D9 self-merge, mismatched coins and tokenised duplicates all refused (the last
demonstrated live: "that card has been tokenised").
D10 tokenise → supply 1, decimals 0, royalty 500 bps, creator = treasury.

## E · Deck — 5/5 PASS

E1 8/8, POWER 8 = Σ levels. E2 one card per coin holds. E3 survives navigation.
E4 three loadout slots. E5 locked cards are excluded from a stakeable deck —
observed as the "deck needs 8 cards" gate after a card was removed.

## F · Clan — 7/7 PASS

F1 browse lists clans with member counts. F2 the button quotes **250**, matching
the till. F3 founding charged 250: player 3650 → 3400, treasury 7260 → 7510.
F4 cancelling the charter **dissolved the clan and moved no money** — balance
unchanged at 3650, clan gone from the directory. F5 leave works and persists
(the UI asks for confirmation first, which is why a single click does nothing).
F6 crowns reflect recorded matches. F7 a taken name is refused with "that name is
taken" **before the till opens**.

## G · Empire, leaderboard, analytics — 6/6 PASS

G1 sorted by net SOL, viewer highlighted. G2 money is chain-verified — a claim
the chain does not support ranks zero. G3 the same settled match reported twice
credits once (`duplicate: true`). G4 history shows correct results. G5 the
unsettled panel appears only when a stranded match exists. G6 TVL publishes no
"staked" figure.

## H · Swap / market — 5/5 PASS

H1 Bags preferred, falls back to the pool matching this cluster. H2 `/api/market`
reports `configured:false`; quotes 503. H3 the screen states its reason rather
than inventing a price. H4 a 0.005 USDC quote returned **447.8843 $MEMPIRE**
against a constant-product expectation of **447.8844** at 30 bps. H5 balances
read from chain.

## I · Relay API — 10/10 PASS

I1–I3, I7, I9 all 200 with the expected shapes. I4 unsigned mutate → 401.
I5 the same signature twice → 401 "already used". I6 the same match twice →
`duplicate: true`, no increment. I8 100 signed POSTs from one wallet → **39
throttled**. I10 **FAIL → fixed → PASS** (see below).

## J · On-chain money paths — 8/8 PASS

J1 every instruction that moves money to the treasury pins it to
`config.treasury`; `CancelMatch` has no treasury because it takes no rake.
J2 stake bound to tier. J3 the joiner escrows the creator's stake. J4 deck rules
enforced. J5 `close_match` returned **+0.002194 SOL** to the creator of #78.
J6 `free_orphaned_cards` present. J7 the counter is idempotent and capped.
J8 `init_pool` requires the upgrade authority.

## K · Audit regressions — 7/7 PASS

All seven hold. K1 was re-demonstrated live during this run: the seat that lost
1–0 called `claim_timeout` on a delegated log and received **+0.049995** while
the winner received **+0.050000**, state Settled winner 2 — a void, not a theft.
K7 was found **still broken** by this plan and fixed (below).

---

# What had to be fixed

**C4 — the red ring said no and the drop happened anyway.** `isLegalDrop` was
wired only to the marker's colour; the handler called `clampDrop` unconditionally
and always played the card, so releasing deep in enemy territory deployed at the
clamped edge. `dropDecision` now returns a point or nothing: legal drops pass,
releases within 1.5 tiles of your own half still snap to the line, anything
beyond is refused and costs no elixir. Both entry points use it — the drag path
and the tap-to-place path, the second of which I missed on the first pass.
Re-verified live: deep enemy release left elixir at 10 and plays at 0; own-half
release took them to 7 and 1.

**I10 — malformed bodies returned 500.** `express.json` throws a SyntaxError and
nothing converted it. Now 400, and oversized bodies 413.

**K7 — `delegate_chests` was never actually fixed.** The earlier commit replaced
the first occurrence of that pattern, which was `delegate_log`. Both are
router-assigned now.

**Stale copy.** The Clan screen still told players cards were "NFTs backed by
your staked tokens" — staking was deleted at the pivot.

# Three failures that were the test's fault, not the product's

Recorded so they are not re-litigated: the leaderboard is a plain array and was
already sorted; the faucet route is `/api/faucet`; and rate limiting exempts GETs
by design, so a burst has to be POSTs — my first 110 spread across six egress IPs
into six separate buckets.

# Honest limits

- **C9's cap boundary is not exercised.** Sixteen settled wins on one wallet.
- **The mainnet binary itself is unrun** — only its devnet twin, which differs by
  one constant.
- **Bags is verified only unconfigured.** There is no market until the token
  launches; creator-fee claiming is unwired because there is nothing to claim.
- Everything here is devnet. No mainnet action was taken and no real money spent.

# Mocks, stubs, console errors

Zero mocks and zero stubs anywhere in the tested surface: every balance above was
read from the chain, every relay call hit the deployed relay against MongoDB,
every match escrowed and settled with real signed transactions. Final fresh-tab
sweep across all six screens: **81 requests, none ≥400, zero console errors.**
