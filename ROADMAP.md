# Mempire — Production Roadmap

50 features and fixes between the current build and a deployable product.
[FEATURES.md](FEATURES.md) holds the monetization argument; this is the
engineering plan.

**Legend:** ✅ shipped · 🔨 next up · ⬜ planned
**Effort:** S (hours) · M (a day) · L (multi-day)

---

## A. Revenue (the reason the rest matters)

| # | Feature | Status | Effort | Note |
|---|---|---|---|---|
| 1 | Battle rake, mint fee, unstake fee | ✅ | — | Live in the program and the client. |
| 2 | Gems as the single hard currency | ✅ | — | Buys time and access, never stats. |
| 3 | Chests with real timers + paid skip | ✅ | — | Four slots; full slots award nothing, which is what makes skips convert. |
| 4 | Card inspector with live market data | ✅ | — | Turns browsing into staking. |
| 5 | Daily Shop, 4 rotating offers, paid reroll | ✅ | — | Liquidity-tiered pricing, flash discounts, gem or SOL. |
| 6 | Tournaments — entry fee, 8% of pool | 🔨 | L | Scales without us operating anything. |
| 7 | Coin sponsorship: "Coin of the Week" | ⬜ | M | B2B. Coin treasuries become customers. Highest ceiling here. |
| 8 | Season Pass, two tracks | ⬜ | L | The most predictable recurring line. |
| 9 | Card Fusion, 0.05 SOL | ⬜ | M | Also destroys supply, supporting held cards. |
| 10 | Cosmetics: arena skins, unit skins, emotes | ⬜ | M | Gem sink with zero balance risk. |
| 11 | Spectator mode + 5% tips | ⬜ | L | Gives top players an audience. |
| 12 | Marketplace with 5% royalty | ⬜ | L | The annuity — compounds forever, costs nothing to run. |
| 13 | Creator codes / referrals | ⬜ | S | Negative-cost acquisition. |
| 14 | Ranked ladder, seasonal SOL prizes | ⬜ | L | Ranked players battle far more; every battle is raked. |
| 15 | Live meme meta — market moves the game | ⬜ | M | Our moat. Impossible without real-asset cards. |

## B. Onchain

| # | Feature | Status | Effort | Note |
|---|---|---|---|---|
| 16 | Anchor program: cards, vaults, pots | ✅ | — | Compiles; eligibility gate and timeout crank included. |
| 17 | Deploy to devnet + seed 12 coins | ✅ | — | Live: `BnLD…FxeP`, IDL onchain, 12 real SPL mints registered, gate verified (BBWHALE/RUGPROOF rejected). |
| 18 | Wire client stores to the program | ✅ | — | Mint/stake/two-step unstake are wallet-signed transactions; real SPL balances shown; explorer receipts; honest live/simulated/offline badge. Match escrow txs exist in `chain/actions.ts`, wired next. |
| 19 | MagicBlock ER delegation | ✅ | — | Live on devnet (`3G4Gidvj…5g6N`). Separate rollup program with no transfer path; 23/23 e2e incl. router placement. |
| 20 | Session keys — no popup per card | ⬜ | M | Non-negotiable for playability. |
| 21 | Bubblegum cNFT layer over card PDAs | ⬜ | M | Makes cards tradeable, which unlocks #12. |
| 22 | Real Jupiter/Pyth price oracle | ⬜ | M | Replaces the devnet mock. |
| 23 | Treasury multisig (Squads) | ⬜ | S | Do not launch with a single-key treasury. |
| 24 | Program security review | ⬜ | M | Real money touches this. |

## C. Game depth

| # | Feature | Status | Effort | Note |
|---|---|---|---|---|
| 25 | Deterministic sim, bot, 3D battle | ✅ | — | Verified deterministic by test. |
| 26 | Drag-and-drop deploy | ✅ | — | Plus a tap fallback. |
| 27 | Crowns, tower fire, spawn/death VFX | ✅ | — | Tower fire was invisible before. |
| 28 | Real human matchmaking | ✅ | — | WS matchmaker + lockstep relay + hash referee; desync voids, disconnect forfeits. Bot steps in after 8s so solo demos never stall. |
| 29 | 3 saved deck slots | ✅ | — | Selected slot mirrors the live deck, so edits survive switching. |
| 30 | Spells: freeze, rage, heal | ⬜ | M | Only one spell archetype exists today. |
| 31 | Buildings: cannon, tesla | ⬜ | M | Adds a defensive axis. |
| 32 | Emotes during battle | ⬜ | S | Feeds #10. |
| 33 | Replays from the input log | ⬜ | M | Nearly free — the log is the replay. |
| 34 | Practice mode, no stake | ✅ | — | No rake, no chest, no history — cannot be farmed. |
| 35 | Clans + Clan Wars | ✅ | — | Full backend (48-assertion test) + fifth tab: browse/found/join, lend loop (+5💎), crown ladder, roles, succession. Clan Wars still ⬜. |

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
| 49 | Rotate the leaked credentials | 🔨 | S | **Do this first.** The Mongo password and the GitHub PAT were both pasted in plaintext. |
| 50 | Geo-blocking + ToS before mainnet | ⬜ | M | A rake on a wagered pot is real-money skill gaming. Devnet is fine; mainnet is not, without this. |

---

## Do these next, in this order

1. **#49 rotate credentials** — everything else can wait behind this.
2. **PvP pots onchain** — matchmaking ships; point `createMatchTx`/
   `joinMatchTx` at the paired match so the escrow is the program's, not the
   simulated ledger's.
3. **#7 coin sponsorship** — the pitch nobody else in the bracket can make, and
   the ad-slot boards in the gutters are already selling it.
4. **#6 tournaments** — 8% of every pool, and it scales without us operating it.
5. **Ship it** — DEPLOY.md is the runbook; both hosts are one click from here.

## The edge-case pass (what "production-ready" actually meant)

The last hardening sweep was not features but the failure modes that decide
whether real users keep their money and progress:

- **Money lands exactly once.** Every abnormal PvP exit — opponent vanishing
  before the start, cancel-after-matched, my own socket dying mid-battle, a
  malformed opponent deck — now refunds or settles the escrow exactly once.
  Before, two of those paths double-charged and one let a single pot pay out
  on both clients.
- **Progress survives reloads.** Gems, the chest rail (absolute timestamps, so
  timers keep running while away), the day's shop and all three deck slots
  persist; saves skip mid-match so a refresh can never freeze a stake out of
  existence.
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

- **The program is live on devnet and mint/stake/unstake are real wallet-signed
  transactions.** Battles against the bot still settle in the simulated ledger:
  onchain settlement needs both players' signatures by design, and a bot has no
  key. Match escrow instructions exist in `chain/actions.ts` and go live with
  human matchmaking (#28).
- **Guest mode is simulated end to end** — it has an address but no keypair,
  and the badge says so.
- **Humans play humans now** over the lockstep relay; a desync voids the match
  (stakes back, no rake) and a disconnect forfeits. Onchain *escrow* for PvP
  pots is the remaining step — the instructions exist in `chain/actions.ts`.
- **Chest drops mint real cards into the collection** (unowned coins first).
  Making those drops cNFTs rides on #21.
- **Clan state lives in MongoDB, not onchain.** Deliberate: it is social
  standing, not custody. Anything that moves value stays in the program.
