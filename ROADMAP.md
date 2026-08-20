# Mempire — Production Roadmap

50 features and fixes between the current build and a deployable product.
[FEATURES.md](FEATURES.md) holds the monetization argument and
[MAINNET.md](MAINNET.md) the launch budget; this is the engineering plan.

**What the game does not do, stated once so the rest of this document reads
correctly:** it never touches a player's holdings. Coins, memecoins and
tokenised stocks are the *roster* — fighters you collect and play with — not
collateral. Staking is gone from the program and the client: the
stake / request_unstake / claim_unstake instructions, the vaults, the 2% exit
fee, the cooldown and the staked-USD level thresholds were all removed, and
every previously-staked token was returned to its owner before removal. Holding
a token is not required to field it. The only value a player ever risks is the
SOL they choose to wager on a match, which the program escrows and pays to the
winner.

**Legend:** ✅ shipped · 🔨 next up · ⬜ planned
**Effort:** S (hours) · M (a day) · L (multi-day)

---

## A. Revenue (the reason the rest matters)

| # | Feature | Status | Effort | Note |
|---|---|---|---|---|
| 1 | Battle rake and card mint fee | ✅ | — | 10% of a pot, 5% on a draw, 0.02 SOL a card. Live in the program and the client. The unstake fee went out with staking. |
| 2 | $MEMPIRE as the single hard currency | ✅ | — | One SPL token, no soft currency beside it. Buys time and access, never stats. |
| 3 | Chests with real timers + paid skip | ✅ | — | Four slots; full slots award nothing, which is what makes skips convert. Chests pay cards, and the duplicates in them are what promote one. |
| 4 | Card inspector with live market data | ✅ | — | Price, liquidity and age on the fighter you are about to field. Holding the token is not required to field it. |
| 5 | Daily Shop, 4 rotating offers, paid reroll | ✅ | — | Liquidity-tiered pricing, flash discounts, $MEMPIRE or SOL. |
| 6 | Tournaments — entry fee, 8% of pool | 🔨 | L | Scales without us operating anything. |
| 7 | Asset sponsorship: "Coin of the Week" | ⬜ | M | B2B. Coin and stock treasuries become customers, and the ask costs them nothing because the game never touches their token. Highest ceiling here. |
| 8 | Season Pass, two tracks | ⬜ | L | The most predictable recurring line. |
| 9 | Merge duplicates to level a card | ✅ | — | Shipped as `upgrade_card`: burn a duplicate, +1 level to a cap of 10, priced per level in $MEMPIRE. This line used to plan a 0.05 SOL "fusion" that granted a stat bonus; that is dropped, because it sold power. Merging still destroys supply. |
| 10 | Cosmetics: arena skins, unit skins, emotes | ⬜ | M | $MEMPIRE sink with zero balance risk. |
| 11 | Spectator mode + 5% tips | ⬜ | L | Gives top players an audience. |
| 12 | Marketplace with 5% royalty | ⬜ | L | The annuity — compounds forever, costs nothing to run. |
| 13 | Creator codes / referrals | ⬜ | S | Negative-cost acquisition. |
| 14 | Ranked ladder, seasonal SOL prizes | ⬜ | L | Ranked players battle far more; every battle is raked. |
| 15 | Live market meta — the market moves the game | ⬜ | M | Our moat. Impossible without real-asset cards, and the roster is coins, memecoins and tokenised stocks, so there is always something moving. |

## B. Onchain

| # | Feature | Status | Effort | Note |
|---|---|---|---|---|
| 16 | Anchor program: cards, merges, pots | ✅ | — | Registry, card PDAs, merge-to-level, match escrow, two-claim settlement, timeout crank. Registry eligibility gate included. No vaults: the stake instructions were deleted, not disabled. |
| 17 | Deploy to devnet + seed the registry | ✅ | — | Live: `BnLD…FxeP`, IDL onchain, gate verified (BBWHALE/RUGPROOF rejected). Devnet was seeded with 12 mints; the mainnet roster is 36 verified assets — majors, memecoins and tokenised stocks — in `server/mainnet-coins.json`. |
| 18 | Wire client stores to the program | ✅ | — | Minting a card and merging a duplicate are wallet-signed transactions, explorer receipts and all, with an honest live/simulated/offline badge. Minting mints *a card account you own*; it neither reads nor requires a balance of the underlying token. |
| 19 | MagicBlock ER delegation | ✅ | — | Live on devnet (`3G4Gidvj…5g6N`). Separate rollup program with no transfer path; 23/23 e2e incl. router placement. Now behind the `rollup` cargo feature and off in the lean launch build — see below. |
| 20 | Session keys — no popup per card | ✅ | — | One temporary keypair authorised at match start, scoped to one seat, one match, thirty minutes, revocable, in memory only. Safe because the rollup program cannot move value. |
| 21 | Cards as real NFTs | ✅ | — | `tokenize_card` mints a Metaplex 1-of-1 (supply 1, mint authority burned) so a card renders in wallets and explorers. Additive, so existing card PDAs can still be tokenised, and behind the `nft` cargo feature. Level stays on the card account, not in metadata. Unlocks #12. |
| 22 | Real onchain price oracle | ⬜ | M | The client already shows live market data from the cached DexScreener feed; the *onchain* price is still admin-set by `set_price`. |
| 23 | Treasury multisig (Squads) | ⬜ | S | Do not launch with a single-key treasury. Today one hot wallet holds upgrade authority, config admin and mint authority — MAINNET.md step 1. |
| 24 | Program security review | 🔨 | M | The internal sweep is closed out (AUDIT.md: five parallel audits, findings recorded fixed or not). A paid external audit is not, and tier caps stay small until it happens. |

## C. Game depth

| # | Feature | Status | Effort | Note |
|---|---|---|---|---|
| 25 | Deterministic sim, bot, 3D battle | ✅ | — | Verified deterministic by test. |
| 26 | Drag-and-drop deploy | ✅ | — | Plus a tap fallback. |
| 27 | Crowns, tower fire, spawn/death VFX | ✅ | — | Tower fire was invisible before. |
| 28 | Real human matchmaking | ✅ | — | WS matchmaker + lockstep relay + hash referee; desync voids, disconnect forfeits. Bot steps in after 8s so solo demos never stall. |
| 29 | 3 saved deck slots | ✅ | — | Selected slot mirrors the live deck, so edits survive switching. |
| 29b | Levels 1→10 earned by winning | ✅ | — | Win a match, earn a chest; chests drop duplicates; merging a duplicate promotes the card. Merging is the only route: no level is sold directly, and none is derived from a balance any more. Replaces the old staked-USD thresholds. |
| 30 | Spells: freeze, rage, heal | ⬜ | M | Only one spell archetype exists today. |
| 31 | Buildings: cannon, tesla | ⬜ | M | Adds a defensive axis. |
| 32 | Emotes during battle | ⬜ | S | Feeds #10. |
| 33 | Replays from the input log | ⬜ | M | Nearly free — the log is the replay. |
| 34 | Practice mode, no wager | ✅ | — | No SOL on the match, no rake, no chest, no history — cannot be farmed. |
| 35 | Clans + Clan Wars | ✅ | — | Full backend (48-assertion test) + fifth tab: browse/found/join, lend loop, crown ladder, roles, succession. The lend loop pays no currency since Crowns were retired. Clan Wars still ⬜. |

## D. Polish and feel

| # | Feature | Status | Effort | Note |
|---|---|---|---|---|
| 36 | Royale Arcade design system | ✅ | — | Quilted field, carved wood, beveled buttons. |
| 36b | Clash-grade arena: grass, frame, river, scenery | ✅ | — | Canvas checker textures, stone towers with tracking cannons. |
| 37 | Generated art + audio set | ✅ | — | Logo, coins, crests, tabs, chests, SFX, music. |
| 38 | Official wallet adapters with real logos | ✅ | — | Phantom, Solflare, Coinbase, Trust, Nightly. |
| 39 | Chest open ceremony | ✅ | — | Shake, burst, sparks, rays. |
| 40 | Living unit motion (hop-march, idle breath) | ✅ | — | Procedural; the meshes have no skeleton. |
| 41 | Rigged unit animation | ✅ | — | KayKit CC0 chibi rigs with Idle/Walk/Attack/Hit/Death, cross-faded. Clips stripped 76→9, five characters in 1.7MB. |
| 42 | Loading screen with art + progress | ✅ | — | Logo, gold progress bar, rotating gameplay tips. |
| 43 | Compress models (meshopt + WebP) | ✅ | — | 46MB → 1.4MB, a 33x reduction. |
| 44 | First-run tutorial | ✅ | — | Four coach marks spotlighting the live controls; once, skippable, replayable. |
| 45 | Victory/defeat cinematics | ⬜ | M | Currently a panel; should be a moment. |
| 46 | Haptics on mobile | ✅ | — | Deploy, chest, purchase only — a signal, not noise. |
| 46b | Full-app design audit and remediation | ✅ | — | 21 findings closed. See note below. |

The audit pass behind #46b is worth recording, because most of it was one
category of mistake. Four P0s were real breakage: the `2× ELIXIR` banner painted
on top of the crown score for the whole double-elixir phase and all of overtime;
the Mint button — the primary conversion action of the Cards screen — was bare
text on wood with a 1.6:1 border; chest slot actions were 26px targets whose
label wrapped at every width and burst the rail; and the ineligibility reason ran
at 2.31:1 on wood.

The rest traced to the same root: **values re-guessed at each call site instead of
being tokens**. Recesses had drifted across eight alpha values of two navies, the
wood surface was hand-rolled at two grain scales (so `.panel .label` never fired
in the battle HUD and it rendered blue text on brown wood), and four sheets each
declared a global `sheetUp` keyframe with different numbers. `.display` hardcoded
a 3px stroke at every size, so nine call sites under 19px turned to blobs — worst
at 13px, where the stroke was 23% of the em on each side. Three components still
carried the retired dark palette, including `MoneyRow`, the pot readout, which
was the last flat 1px rectangle in the game and bordered in the *superseded* gold.
`Pill` drove `ghost` and `disabled` from one flag, so on the forfeit confirm the
destructive option was the only one that looked pressable.

Fixed by adding `--recess`, `--r-sheet`, `--red-on-wood`, `.wood`, `.sheet`,
`.display--sm`, `.icon-btn`, `.menu-item` and a `Spinner`, then deleting the
literals. DESIGN.md records each rule with the failure that produced it.

## E. Production readiness

| # | Feature | Status | Effort | Note |
|---|---|---|---|---|
| 47 | MongoDB persistence | ✅ | — | Debounced, fire-and-forget, degrades to local. |
| 48 | Deploy: Vercel (app) + Railway (API) | ✅ | — | `app/vercel.json`, `server/railway.json`, env examples both sides, DEPLOY.md runbook. |
| 49 | Rotate the leaked credentials | 🔨 | S | **Do this first.** The Mongo password, the GitHub PAT and the Heroku token were all pasted in plaintext. |
| 50 | Geo-blocking + ToS before mainnet | ⬜ | M | A rake on a wagered pot is real-money skill gaming. Devnet is fine; mainnet is not, without this. |
| 50b | Lean mainnet build | ✅ | — | The heavy subsystems are cargo features, so launch does not pay for them. Numbers below. |

---

## Mainnet costs ~3.2 SOL, and most of it comes back

The launch budget was 12 SOL when everything was one binary. Rent scales with
program bytes, so the fix was to make the two heaviest subsystems optional:
`nft` (Metaplex 1-of-1 cards, #21) and `rollup` (MagicBlock ER and VRF chests,
#19). Measured from this repo's own builds:

| Build | Bytes | SOL |
|---|---|---|
| lean (`--no-default-features`) | 463,456 | 3.23 |
| default, both features | 704,432 | 4.90 |

The lean build is the whole game: roster, decks, chests, escrowed PvP pots,
two-claim settlement, timeouts. Two things are worth being precise about.
First, deploy rent is a **refundable deposit** — `solana program close` returns
it to the authority — so the launch is not a 3.2 SOL spend, it is a 3.2 SOL
deposit plus about 0.05 in fees. Second, **settlement is identical with or
without the rollup**: settlement reads the two seats' claims off the log
whether that log ever visited a rollup or not. Turning the rollup off costs the
onchain play log and VRF-rolled chests, not the money path. `solana program
extend` plus an upgrade buys the features later, out of revenue.

MAINNET.md holds the ordered runbook and the per-step costs.

## Do these next, in this order

1. **#49 rotate credentials** — everything else can wait behind this.
2. **#23 treasury multisig** — the last single point of total failure before
   real money moves.
3. **Launch the lean build** — MAINNET.md is the runbook, ~3.2 SOL of it
   refundable, and the app flips cluster on two env vars.
4. **#7 asset sponsorship** — the pitch nobody else in the bracket can make,
   and the ad-slot boards in the gutters are already selling it.
5. **#6 tournaments** — 8% of every pool, and it scales without us operating it.

## The edge-case pass (what "production-ready" actually meant)

The last hardening sweep was not features but the failure modes that decide
whether real users keep their money and progress:

- **Money lands exactly once.** Every abnormal PvP exit — opponent vanishing
  before the start, cancel-after-matched, my own socket dying mid-battle, a
  malformed opponent deck — now refunds or settles the escrow exactly once.
  Before, two of those paths double-charged and one let a single pot pay out
  on both clients.
- **Progress survives reloads.** The collection and its levels, the chest rail
  (absolute timestamps, so timers keep running while away), the day's shop and
  all three deck slots persist; saves skip mid-match so a refresh can never
  freeze a wagered pot out of existence.
- **Migrations cannot crash returning players.** Retired-mint cards are pruned
  on load, decks self-repair, and a deck that still cannot fight produces a
  sentence, not a stack trace.
- **Background tabs don't stall matches.** Bot and human matches both pace
  against the wall clock; a hidden tab lags and fast-forwards on return.
- **The server assumes hostility.** Deck payloads validated at the sender's
  door, input relay rate-capped per socket, mutating HTTP routes rate-limited
  per IP, every stored number clamped, match rooms swept after a TTL.
- **Boundaries don't leak.** No formatter can render NaN; a dead RPC is a
  tappable retry, not a permanent red dot; a live badge never sits above a
  simulated purchase without saying so.

## MagicBlock Ephemeral Rollups

The battle loop runs on a MagicBlock ephemeral rollup, **live on devnet** at
`3G4GidvjQd3yQK4bqZfem8Kkmcboygze42RcjrXg5g6N` with its IDL published. Proven end
to end in both environments by one script (`chain/scripts/e2e-rollup.ts`):
23/23 on devnet including hosted router placement, 22/22 on localnet.

**It is a `rollup` cargo feature, and mainnet launches without it** (see the
budget above). What that costs is the onchain play log and VRF-rolled chests —
without the rollup a chest rolls from a locally recorded seed and the UI says
which of the two produced it. What it does not cost is the money path:
settlement takes the two seats' claims off the log either way, so a pot escrows,
settles and times out identically in both builds. The rollup is bought back with
`solana program extend` and an upgrade when revenue pays for it.

**Two programs, and the split is the safety argument.** `mempire_rollup`
(`3G4Gidvj…5g6N`) owns only the delegated `MatchLog` — the input log and the
newest state-hash checkpoint. It holds no lamports beyond its own rent and has
**no transfer path at all**, so a delegated log can never guard a pot. Escrow,
deck locks and payout stay in `mempire` on base layer. A rollup that stalls costs
latency and falls back to `claim_timeout`.

Settlement deliberately does **not** ride a post-commit Magic Action: an action
that fails can be stripped from its whole transaction strategy before the
committor retries, and a payout must never depend on that.

What the run proves: the router places the log on a real rollup and returns its
FQDN; delegation flips base ownership to the delegation program while the ER
reports our program as owner (the delegation invariant); card plays land on the
rollup with seats, coordinates and hashes intact; the rollup enforces
authorization rather than just routing (a non-player is rejected with
`NotAPlayer`, a replayed tick with `StaleTick`); `commit_and_undelegate` returns
the log to base layer with its rollup state intact; and a sealed log's rent is
reclaimable.

**Latency, stated with its conditions.** 7–17ms on localnet, where the ER runs on
the same machine. **~475ms confirmed** against the hosted devnet rollup — that
figure is dominated by network round-trip and waiting for `confirmed`, not by
execution, and the router placed us on the nearest region. Quoting the localnet
number as the hosted experience would be a two-order-of-magnitude overstatement,
so both appear here. The architectural win is that the input log is genuinely
onchain rather than relayed by our own matchmaker; the latency win is real but
co-location dependent.

Three findings worth keeping, each of which cost real debugging time:

1. **`DelegateConfig::validator` must be set on localnet.** Left as `None` the
   delegation is unassigned, and a specific ER refuses writes with
   `InvalidWritableAccount` even though base ownership flips and the ER clone
   reports the right owner — the error points nowhere near the cause. On devnet
   the router assigns placement, so `None` is correct there.
2. **Flush before committing.** Anchor serializes `Account<T>` mutations when the
   instruction exits, but `commit_and_undelegate` transfers the account away
   *during* the instruction, so the deferred write lands after ownership changed
   and fails with "modified data of an account it does not own". `exit()` before
   the CPI makes the committed state the sealed state.
3. **ER mutability sync is asynchronous.** A clone can arrive read-only and
   become writable a moment later, so the first write is polled rather than
   attempted once.

Still unproven: behaviour under sustained load, and multi-region failover (the
router placed every run on the same region from here).

## Known limits, stated plainly

- **The program is live on devnet, and minting a card and merging a duplicate
  are real wallet-signed transactions.** Battles against the bot still settle in
  the simulated ledger: onchain settlement needs both players' signatures by
  design, and a bot has no key.
- **PvP pots are escrowed onchain.** `state/escrow.ts` drives
  create → join → settle, with cancel and `claim_timeout` for every abnormal
  exit. A desync voids the match (wagers back, no rake) and a disconnect
  forfeits.
- **Guest mode is a real ed25519 keypair in the browser**, so a guest genuinely
  signs and genuinely mints. Its SOL balance is simulated, which means a guest
  plays for the ladder and cannot wager — the badge says so.
- **Chest drops mint real cards into the collection** (unowned assets first, so
  a drop teaches a new fighter before it repeats one). Whether those cards
  render as NFTs rides on the `nft` feature (#21).
- **Clan state lives in MongoDB, not onchain.** Deliberate: it is social
  standing, not custody. Anything that moves value stays in the program.
- **Nothing in the game holds a player's tokens.** There is no vault, no lock
  and no instruction that can move an asset out of a player's wallet — the
  program can only move the SOL a player wagered on a match, and only to a
  winner, a refund or a timeout claim.
