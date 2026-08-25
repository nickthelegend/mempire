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
