# Mempire

**Your bags are your army.** A 3D real-time Clash Royale-style card battler on Solana:
mint NFT cards from meme coins you actually hold, stake tokens into them for power,
build an 8-card deck, and fight 1v1 for a staked SOL pot. Winner takes 90%.

Built for **Solana Blitz V7** · [mempire.fun](https://mempire.fun)

## How it plays

1. **Connect** — a wallet picker detects Phantom / Backpack / Solflare (install
   links when missing), plus a labeled **Guest** mode so anyone can play the
   whole game with a simulated balance. Trusted wallets reconnect silently.
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
        └─ src/three    3D arena + KayKit CC0 rigged units (swap-ready for
                        generated chibi models), spawn shockwaves, damage
                        flashes, billboarded HP bars, drop markers
        └─ src/screens  Arena / Cards / Deck / Empire / Battle (mobile column)
        └─ public/art   generated logo, 12 coin logos, 6 archetype crests
        └─ public/sfx   6 SFX + battle music loop
chain/  Anchor workspace — program `mempire`
        config · coin registry + mock oracle · card PDAs + stake vaults ·
        two-step unstake · match escrow + dual-sig settle + timeout claims
design/ PRODUCT.md + DESIGN.md authority, asset manifest, Higgsfield prompt pack
```

**Battle model** (the onchain story): card plays are an input log
`{tick, player, handIndex, x, y}`. Both clients run the identical integer-only
sim; state hashes commit every 40 ticks; settlement takes the final hash signed
by both players. Next hardening step: delegate the match account to a
[MagicBlock ephemeral rollup](https://magicblock.gg) so the input log and hash
checkpoints commit gaslessly in real time, with session keys replacing per-play
wallet popups (the sim + hash design is already ER-shaped).

## Run it

```bash
# app (mock-chain demo, judge-ready)
cd app && npm install && npm run dev

# sim determinism check
cd app && npx tsx scripts/sim-test.ts

# program
cd chain && anchor build

# devnet seed: 12 meme coins + config + mock oracle prices
cd chain && npx tsx scripts/seed-devnet.ts
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

Solana Royale: near-black violet void, one centered 430px column (arcade-cabinet
on desktop), Solana purple→teal gradient for interaction, royal gold **only**
when SOL moves, chunky arcade lettering (Lilita One) over Hanken Grotesk, money
in Martian Mono. Full authority in `DESIGN.md`; product truth in `PRODUCT.md`.

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
- [ ] Wire app stores to the program (adapter skeleton in place)
- [ ] Persist collection/deck/history across reloads
- [ ] MagicBlock ER delegation + session keys
- [ ] Bubblegum cNFT mint layer over card PDAs
- [ ] Generated chibi unit models (prompt pack ready in `design/`)
- [ ] Fusion, battle pass, cosmetics, 2v2
