# Mempire

**Every coin is a fighter.** A 3D real-time Clash Royale-style card battler on
Solana where the roster is the market itself — memecoins, majors and tokenised
stocks, each one a card with its own art, archetype and stats. Collect them,
build an 8-card deck, and fight 1v1 for a staked SOL pot. Winner takes 90%.

**You never hand over your holdings.** Mempire does not custody, lock or stake
anyone's tokens. The coins are *characters*, not collateral: you play with BONK
the way you'd play with a chess piece. The only thing you ever risk is the SOL
you choose to put on a match, and even that is escrowed by a program that pays
out to whoever wins.

[play.mempire.fun](https://play.mempire.fun) · live on devnet, free, no install,
no wallet required to start.

## How it plays

1. **Play** — open the site and you're in. Guest mode is a real keypair in your
   browser, so the whole game works with no wallet installed; connect Phantom,
   Solflare, Coinbase, Trust or Nightly whenever you want to own things properly.
2. **Collect fighters** — 36 verified assets at launch: majors (BTC, ETH, SOL),
   memecoins (BONK, POPCAT, MEW, PEPE, BRETT), and tokenised stocks (NVDA, META,
   MSTR, V). Coin → archetype is deterministic: `fnv1a(mint) % 6` → Tank / Swarm
   / Ranged / Splash / Support / Spell, so a card's identity is fixed by its mint
   and nobody can reroll into a better one.
3. **Mint cards** — 0.02 SOL. That mints *a card*, an account you own, not your
   coins. Holding the underlying token is not required and never was on this
   build; anyone can field any fighter in the registry.
4. **Level by winning** — win a match, earn a chest; chests drop duplicates;
   merging a duplicate promotes the card, 1 → 10. Levels are earned, never
   bought: there is no way to pay for power.
5. **Battle** — pick a tier (0.05 / 0.25 / 1 / 5 SOL, bracketed by deck power),
   **drag cards onto your half** of the arena (a ghost tracks your finger, the
   ring turns teal when the drop is legal and red when it isn't), fell towers for
   crowns, pot settles onchain. House rake 10% (5% on a draw).

Stakes escrow only when the match actually starts — cancelling a search costs
nothing. If an opponent abandons, the pot is recoverable by timeout, and the
result screen always says which of those happened.

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
        config · coin registry · card PDAs · merge-to-level · Metaplex 1-of-1s
        match escrow + two-claim settle + timeout claims · MagicBlock rollup
        (`nft` and `rollup` are cargo features — see MAINNET.md for why)
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
a fortune in oracle fees for cosmetics.

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
# app — reads the live devnet program; guest mode needs no wallet
cd app && npm install && npm run dev

# sim determinism check
cd app && npx tsx scripts/sim-test.ts

# program (already live at BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP)
cd chain && anchor build

# devnet seed: coin registry + config (resumable on 429)
cd chain && npx tsx scripts/seed-devnet.ts

# build the mainnet roster from Jupiter-verified identities (read-only, free)
cd chain && node build-mainnet-registry.mjs

# the lean launch build — 463 KB, ~3.2 SOL to deploy (see MAINNET.md)
cd chain && anchor build -- --no-default-features --features mainnet

# read the live onchain state back
cd chain && npx tsx scripts/verify-devnet.ts

# prove the onchain half end to end (spends ~0.004 devnet SOL)
cd chain && npx tsx scripts/e2e-devnet.ts

# clan API integration test + demo clans (server must be running)
cd server && node test-clans.mjs && node seed-clans.mjs

# persistence + live coin API (needs server/.env — see server/.env.example)
cd server && npm install && npm run dev
```

Everything above talks to the real deployed program on devnet — cards, matches,
escrow and settlement are signed transactions, not a mock. You can play with no
wallet installed (guest mode is a real keypair in the browser) and with no
holdings at all. A bot fills in when nobody is queued, and says so: a bot match
reads NO STAKE and escrows nothing, because a bot has no key to escrow with.

## Fees (the business)

| Action | Fee | Live? |
|---|---|---|
| Battle rake | 10% of pot (5% on a draw) | yes |
| Card mint | 0.02 SOL | yes |
| Chest timer skip | 25 $MEMPIRE | yes |
| Extra chest slot | 100 $MEMPIRE | yes |
| Shop purchase / paid reroll | 250 / 35 $MEMPIRE | yes |
| Clan charter | 250 $MEMPIRE | yes |
| Merge fee | 100 × level $MEMPIRE | yes |
| NFT royalties | 5% | on tokenised cards |

Every line above is shipping today, not roadmap. Two honest notes on the merge
fee, because "you can't buy power" would be too strong a claim: levelling needs
a **duplicate**, and duplicates come from chests you earn by winning — but the
daily shop mints real cards, so a paid path to a duplicate does exist. It is
four rotating offers, not a targeted upgrade, and the merge itself still
charges 100 × level. What is genuinely absent is any fee on a player's own
tokens, because the game never holds them.

## Go-to-market

**Positioning: the market is the roster.** Clash Royale, except every fighter is
a real asset — BONK, POPCAT, NVDA, BTC — with art and stats of its own. That reads
instantly to two audiences who never share a game: crypto people who know the
tickers, and mobile gamers who just want a good three-minute match. Critically,
nobody has to own anything to play, so the top of the funnel is the entire
internet rather than the subset holding eight specific tokens.

### Why the funnel converts

Ten seconds to playing: no install, no wallet, no holdings. Win a match, earn a
chest; chests drop duplicates; merging promotes a card. Wanting to keep what
you've won is what makes a wallet worth connecting — and a connected wallet
unlocks real pots and cards that show up in Explorer as NFTs you own. Each step
is a live, tested flow (`VERIFICATION-REPORT.pdf`), so growth is a volume
problem, not a fixing problem.

### Channels

| Channel | Why it compounds |
|---|---|
| **Asset communities** | 36 verified fighters at launch, each with a community that wants *their* ticker to top the board. Per-asset leaderboards and season wars give BONK vs POPCAT a scoreboard. Getting added to the roster is the BD ask — and it costs them nothing, because we never touch their token. |
| **Solana ecosystem** | A real-time onchain game with escrowed pots and settlement is a showcase integration, which earns listings and co-marketing without ad spend. |
| **Creators & clips** | Three-minute matches with real pots are natively clippable, and SHARE 𝕏 is already on the result screen. Seed a small creator pool in $MEMPIRE. |
| **Onchain receipts** | Every pot and NFT is a public transaction. The Explorer link is the ad. |

### Phased launch

1. **Now — devnet open beta.** Free, weekly leaderboard seasons, zero spend.
   Goal: a Discord of regulars and proof the loop is fun before money moves.
2. **Mainnet launch — ~3.2 SOL.** The lean build (see `MAINNET.md`): the whole
   game, real escrowed pots, the full 36-asset roster. Small tiers only
   (0.05 SOL cap). Goal: prove rake revenue with capped risk. Almost all of that
   3.2 is *recoverable rent*, not spend — closing the program returns it.
3. **+1.6 SOL — cards as NFTs.** `solana program extend` and upgrade; cards
   start rendering in wallets and explorers.
4. **+3.1 SOL — the rollup.** MagicBlock ER: plays land on a rollup mid-match,
   VRF-rolled chests, on-chain play log. Funded out of rake, not out of pocket.
5. **Then** — clan tournaments with rake-funded prizes, the Android wrapper
   (keystore already cut), a third-party audit, higher tiers.

### Revenue is shipping, not planned

Rake on every pot, card mints, chest skips and slots, shop purchases and paid
rerolls, clan charters. $MEMPIRE has sinks before it has emissions, which is the
right order — and none of it depends on anyone locking up an asset.

### KPIs that decide the next phase

Guest→wallet conversion · D1/D7 retention · matches per DAU · weekly rake ·
asset communities activated · % of matches that settle onchain.

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
- [x] Anchor program: registry, cards, merge-to-level, escrow, settle, timeouts
- [x] Devnet seed script (coin registry + config, resumable)
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
- [x] **Program live on devnet** — deployed and proven by a 92-item test plan
      run against the real product (`TESTPLAN.md`, `VERIFICATION-REPORT.pdf`)
- [x] Client wired: mint, merge, match escrow and settlement are wallet-signed
      transactions with explorer receipts and an honest live/offline badge
- [x] Staking retired — the game never touches a player's holdings
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

- **Everything verified so far is devnet.** The programs are deployed and the
  92-item plan passes against the live product, but mainnet execution waits on
  funding (`MAINNET.md`, ~3.2 SOL).
- **The programs are not third-party audited.** Compensating controls: small
  stake tiers cap exposure, and the settlement design voids rather than pays
  when the two seats disagree — a cheat costs the cheater the match, it cannot
  pay them. One documented residual (`AUDIT.md` C9): a sore loser can force a
  void and get their own stake back, denying the winner the pot. They cannot
  steal. Closing it needs the play log verified onchain.
- **A lean launch defers two things.** Built without the `nft` and `rollup`
  features, cards are program accounts rather than NFTs and chests roll from a
  local seed that is labelled as such. Both come back with a program extend and
  an upgrade; matches escrow and settle identically either way.
- **The relay runs one replica.** Its matchmaking queues are in memory, so a
  deploy drops queued players — not matches, which live on chain.
- **Bots exist for solo play** and are labelled: a bot match says NO STAKE and
  escrows nothing, because a bot has no key to escrow with.
- **Guest mode is devnet-only for signing.** On mainnet a browser-held key is
  refused for anything that holds value, and the connect screen says so.
