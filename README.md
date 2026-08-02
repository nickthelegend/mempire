# Mempire

**Your bags are your army.** A 3D real-time Clash Royale-style card battler on Solana:
mint NFT cards from meme coins you actually hold, stake tokens into them for power,
build an 8-card deck, and fight 1v1 for a staked SOL pot. Winner takes 90%.

Built for **Solana Blitz V7** · [mempire.fun](https://mempire.fun)

## How it plays

1. **Connect** — the official Solana wallet adapters (Phantom, Solflare,
   Coinbase, Trust, Nightly) with their real logos and true install detection,
   plus a labeled **Guest** mode so anyone can play the whole game with a
   simulated balance. Trusted wallets reconnect silently.
2. **Scan bags** — your SPL meme coins appear; coins need ≥$25k liquidity and ≥48h
   age to mint (kills the "mint your own coin, stake 1B supply, god card" exploit).
3. **Mint cards** — 0.02 SOL fee. Coin → archetype is deterministic:
   `fnv1a(mint) % 6` → Tank / Swarm / Ranged / Splash / Support / Spell.
4. **Stake** — lock coin tokens in the card's vault. Staked USD (snapshotted at
   stake time) sets level 1–10 on a diminishing curve — whales buy an edge, never
   the win. Unstake is two-step with a 72h cooldown (60s on devnet) and 2% fee.
5. **Battle** — pick a tier (0.05 / 0.25 / 1 / 5 SOL, bracketed by deck power),
   **drag cards onto your half** of the arena (a ghost tracks your finger, the
   ring turns teal when the drop is legal and red when it isn't), fell towers for
   crowns, pot settles onchain. House rake 10% (5% on a draw).

Stakes escrow only when the match actually starts — cancelling a search costs
nothing. You can only stake tokens you genuinely hold, and unstaking is a
two-step claim with a live cooldown.

## Architecture

```
app/    Vite + React + TS + React Three Fiber + Zustand
        └─ src/sim      deterministic lockstep engine: fixed-point i32 (1/1024),
                        20 ticks/s, 3min + 60s OT, xorshift RNG, FNV-1a state
                        hash every 40 ticks, 2-tick input delay, bot opponent
        └─ src/three    Clash-style arena (checkered grass, wood frame, river,
                        scenery) + rigged chibi units with real skeletal
                        animation, stone towers with tracking cannons
        └─ src/chain    client for the deployed program: PDA derivation, typed
                        reads, every write instruction, deck commitments, and a
                        read-only provider that throws if anything tries to sign
        └─ src/screens  Arena / Cards / Deck / Clan / Empire / Battle
        └─ src/state    collection · deck · match · economy · clan · chain · sync
        └─ public/art   logo, 12 coin logos, 6 crests, tab icons, chests, ad board
        └─ public/sfx   10 SFX + menu and battle music loops
        └─ public/models 5 rigged chibi units, meshopt-compressed (1.7MB total)
chain/  Anchor workspace — program `mempire`, LIVE on devnet
        config · coin registry + mock oracle · card PDAs + stake vaults ·
        two-step unstake · match escrow + dual-sig settle + timeout claims
        scripts: seed-devnet (resumable) · verify-devnet · e2e-devnet (16 checks)
server/ Express API — player persistence (MongoDB), cached live coin feed,
        leaderboard, and the full clan service (48-assertion integration test)
design/ generation pipeline: gen.sh, gen-audio.sh, gen-3d.sh, slice.py
```

**Battle model** (the onchain story): card plays are an input log
`{tick, player, deckIndex, x, y}`. Both clients run the identical integer-only
sim; state hashes commit every 40 ticks; settlement takes the final hash.

That log lives on a [MagicBlock ephemeral rollup](https://magicblock.gg), live on
devnet at `3G4Gidvj…5g6N`. A `MatchLog` PDA is delegated at match start, card
plays and hash checkpoints are written to the rollup, and
`commit_and_undelegate` returns the sealed log to Solana at the end.

The rollup program is deliberately separate from the money program and has **no
transfer path**, so a delegated log can never strand a pot — escrow and payout
stay on base layer in `mempire`, and a stalled rollup degrades to
`claim_timeout`.

**The log is private (PER).** The sim runs two ticks behind the input a player
submits, which is what hides network latency — and that delay is only safe while
nobody can read the log faster than the sim consumes it. An observer polling the
rollup could otherwise see the opponent's card and placement *before* it resolves
on screen. So the log is sealed inside a TEE-backed validator with an ER-local
`EphemeralPermission` whose only members are the two seats. Delegation decides
where the account lives; the permission decides who may look. There is no
base-layer permission account — it is created, updated and closed entirely on
the rollup, and closed before the log is undelegated.

**Chests are rolled by VRF.** Chest tiers used to be `Math.random()` in the
client, which is exactly the mechanic players are right to distrust in a game
that also holds real SOL. They now come from the MagicBlock VRF oracle, and the
32 bytes that produced each drop are stored on the chest so anyone can re-derive
it. Requests go to the *delegated* queue from inside the rollup: MagicBlock
prices ER randomness at zero and base-layer randomness at 0.0008 SOL per
request, and a player opening four chests a session should not pay a fraction of
a Pauper stake in oracle fees for cosmetics.

Measured play latency, both stated with their conditions because they differ by
two orders of magnitude: **7–17ms** on localnet, where the ER is on the same
machine, and **~475ms confirmed** against the hosted devnet rollup, which is
dominated by network round-trip and `confirmed` commitment rather than by
execution. The honest read is that the ER's benefit is real but co-location
dependent; the architectural win here is that the input log is genuinely onchain
rather than relayed by our own server.

```bash
# devnet (includes hosted router placement)
cd chain && BASE_RPC=https://api.devnet.solana.com npx tsx scripts/e2e-rollup.ts
# localnet (needs `npx mb-stack` running)
cd chain && npx tsx scripts/e2e-rollup.ts
```

## Run it

```bash
# app (mock-chain demo, judge-ready)
cd app && npm install && npm run dev

# sim determinism check
cd app && npx tsx scripts/sim-test.ts

# program (already live at BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP)
cd chain && anchor build

# devnet seed: 12 meme coins + config + mock oracle prices (resumable on 429)
cd chain && npx tsx scripts/seed-devnet.ts

# read the live onchain state back
cd chain && npx tsx scripts/verify-devnet.ts

# prove the onchain half end to end (spends ~0.004 devnet SOL)
cd chain && npx tsx scripts/e2e-devnet.ts

# clan API integration test + demo clans (server must be running)
cd server && node test-clans.mjs && node seed-clans.mjs

# persistence + live coin API (needs server/.env — see server/.env.example)
cd server && npm install && npm run dev
```

The demo runs fully on seeded/simulated devnet data — no funded wallet needed,
and a bot opponent means no second human either. Balances, opponents, and the
settlement feed in the mock build are simulated and labeled as such in-app.

## Fees (the business)

| Action | Fee |
|---|---|
| Card mint | 0.02 SOL |
| Battle rake | 10% of pot (5% on draw) |
| Unstake | 2% |
| Fusion (post-MVP) | 0.05 SOL |
| NFT royalties (post-MVP) | 5% |

## Design

**Royale Arcade** — Clash Royale's chrome carrying Mempire's content: a quilted
royal-blue field, carved wood panels, fat buttons that depress into their own
base edge, chunky outlined display type (Lilita One). Royal gold means exactly
one thing: SOL is moving. One centered 430px column, arcade-cabinet on desktop.
Verified at 320/375/430px: no readable string under 12px, no touch target under
44px, no horizontal overflow.
Full authority in `DESIGN.md`; product truth in `PRODUCT.md`; the monetization
argument in `FEATURES.md`; the 50-item build plan in `ROADMAP.md`; what comes
after the deadline in `AFTER_HACKATHON.md`.

Art and audio are generated through the Higgsfield CLI and committed:
`design/gen.sh` (images), `design/gen-audio.sh` (sound), `design/slice.py`
(cuts grid sheets into keyed transparent PNGs). One STYLE FORMULA, held
byte-identical across every prompt, keeps the set coherent.

## Status & roadmap

- [x] Deterministic sim + bot + 3D battle + full screen flow (playable now)
- [x] Drag-and-drop deploy, crown score, sound, spawn/damage VFX
- [x] Wallet picker (Phantom/Backpack/Solflare + Guest), error boundary
- [x] Generated art + audio set wired in
- [x] Anchor program: registry, cards, vaults, escrow, settle, timeouts
- [x] Devnet seed script (12 coins, mock oracle, eligibility gate demo)
- [x] Official Solana wallet adapters with real logos
- [x] Chests, Gems, card inspector with live pump.fun market data
- [x] MongoDB persistence, model compression (46MB → 1.7MB), loading screen
- [x] Rigged animated units, Clash-grade arena, daily Shop, practice mode
- [x] Full design audit: 21 findings closed, 12px legibility floor enforced
- [x] MagicBlock ephemeral rollup live on devnet: card plays onchain, 23/23 e2e
- [x] **PER** — match log sealed to its two seats inside an ER-local ephemeral
      permission; **VRF** — provably-fair chest tiers from the oracle, with the
      randomness stored for verification. 20/20 against devnet and the live
      oracle (`scripts/e2e-per-vrf.ts`)
- [x] **Program live on devnet** — deployed, seeded with 12 real SPL mints,
      proven by a 16-assertion onchain e2e (mint, gate, stake, 2-step unstake)
- [x] Client wired: mint/stake/unstake are wallet-signed transactions with
      explorer receipts and an honest live/simulated/offline badge
- [x] Clans: full backend (48-assertion test) + browse/found/join/lend UI
- [x] First-run tutorial, server leaderboard, ad-slot boards in the gutters
- [x] Human vs human: WS matchmaker, lockstep input relay, hash referee
      (desync voids the match), disconnect forfeits — 12-assertion protocol test
- [x] Chest drops mint real cards; deploy runbook (DEPLOY.md) + host configs
- [ ] Tournaments, coin sponsorship, season pass (see `ROADMAP.md`)
- [ ] Session keys (zero wallet popups mid-battle)
- [ ] Bubblegum cNFT mint layer over card PDAs
- [ ] Fusion, battle pass, cosmetics, 2v2

## Known limits, stated plainly

- The program is live on devnet and mint/stake/unstake are real wallet-signed
  transactions. Match pots still settle in the simulated ledger: onchain
  settlement needs both players' signatures by design, so it arrives when the
  escrow instructions (already in `chain/actions.ts`) are pointed at paired
  PvP matches. A bot has no key, so bot matches stay simulated forever.
- Guest mode is simulated end to end, and the in-app badge says which mode
  you are in at all times.
- Humans play humans over a lockstep relay with hash checkpoints; a desync
  voids the match (stakes back, no rake). The bot steps in after 8s so a solo
  judge always gets a battle.
- Chest drops mint real cards into the collection; making them cNFTs rides
  on the Bubblegum layer.
- Clans live in MongoDB, not onchain — social standing, not custody.
