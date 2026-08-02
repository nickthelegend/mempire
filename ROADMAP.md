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
| 17 | Deploy to devnet + seed 12 coins | 🔨 | S | **Blocked:** needs ~3.5 devnet SOL in the deploy wallet. |
| 18 | Wire client stores to the program | 🔨 | L | The last mile between a great demo and a real product. |
| 19 | MagicBlock ER delegation | ⬜ | L | Sim and hash design is already ER-shaped. |
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
| 28 | Real human matchmaking | 🔨 | L | Offchain matchmaker; the bot stays for demos. |
| 29 | 3 saved deck slots | ⬜ | S | Store already has the field. |
| 30 | Spells: freeze, rage, heal | ⬜ | M | Only one spell archetype exists today. |
| 31 | Buildings: cannon, tesla | ⬜ | M | Adds a defensive axis. |
| 32 | Emotes during battle | ⬜ | S | Feeds #10. |
| 33 | Replays from the input log | ⬜ | M | Nearly free — the log is the replay. |
| 34 | Training arena vs bot, no stake | ⬜ | S | Lets new players learn without losing SOL. |
| 35 | Clans + Clan Wars | ⬜ | L | Strongest retention mechanic in the genre. |

## D. Polish and feel

| # | Feature | Status | Effort | Note |
|---|---|---|---|---|
| 36 | Royale Arcade design system | ✅ | — | Quilted field, carved wood, beveled buttons. |
| 36b | Clash-grade arena: grass, frame, river, scenery | ✅ | — | Canvas checker textures, stone towers with tracking cannons. |
| 37 | Generated art + audio set | ✅ | — | Logo, coins, crests, tabs, chests, SFX, music. |
| 38 | Official wallet adapters with real logos | ✅ | — | Phantom, Solflare, Coinbase, Trust, Nightly. |
| 39 | Chest open ceremony | ✅ | — | Shake, burst, sparks, rays. |
| 40 | Living unit motion (hop-march, idle breath) | ✅ | — | Procedural; the meshes have no skeleton. |
| 41 | Rigged unit animation | ⬜ | L | The auto-rigger is humanoid-only and fails on animal silhouettes. Options: hand-rig in Blender, or buy a rigged chibi pack and retexture. |
| 42 | Loading screen with art + progress | ✅ | — | Logo, gold progress bar, rotating gameplay tips. |
| 43 | Compress models (meshopt + WebP) | ✅ | — | 46MB → 1.4MB, a 33x reduction. |
| 44 | First-run tutorial | ⬜ | M | Judges arrive cold. |
| 45 | Victory/defeat cinematics | ⬜ | M | Currently a panel; should be a moment. |
| 46 | Haptics on mobile | ✅ | — | Deploy, chest, purchase only — a signal, not noise. |

## E. Production readiness

| # | Feature | Status | Effort | Note |
|---|---|---|---|---|
| 47 | MongoDB persistence | ✅ | — | Debounced, fire-and-forget, degrades to local. |
| 48 | Deploy: Vercel (app) + Railway (API) | 🔨 | S | Plus `VITE_API_URL` wired per environment. |
| 49 | Rotate the leaked credentials | 🔨 | S | **Do this first.** The Mongo password and the GitHub PAT were both pasted in plaintext. |
| 50 | Geo-blocking + ToS before mainnet | ⬜ | M | A rake on a wagered pot is real-money skill gaming. Devnet is fine; mainnet is not, without this. |

---

## Do these next, in this order

1. **#49 rotate credentials** — everything else can wait behind this.
2. **#17 + #18** devnet deploy (fund `3YUgUPu9AdJj6FCFFvzR9pJixCN7EcAnCXMJoTuYwsS5`
   with ~3.5 devnet SOL) then wire the client. This converts "great demo" into
   "working product", which is the judging line.
3. **#7 coin sponsorship** — the pitch nobody else in the bracket can make.
4. **#6 tournaments** — 8% of every pool, and it scales without us operating it.
5. **#41 rigged units** — the last visible gap between this and a shipped game.

## Known limits, stated plainly

- **Units are static meshes.** They move convincingly, but nothing articulates.
  Real skeletal animation needs #41.
- **The economy is simulated on devnet.** Balances, opponents and the settlement
  feed are mock; the program that would make them real exists but is undeployed.
- **One human cannot yet play another.** The bot is a real opponent running the
  same simulation, but #28 is unbuilt.
- **Chest contents are not yet minted cards.** The ceremony awards gems and
  reports card counts; wiring drops to real mints is part of #18.
