# After the hackathon

What Mempire becomes once the Blitz V7 deadline stops setting the agenda.

This is deliberately ordered by dependency, not by excitement. Each phase makes
the next one worth building; doing them out of order produces features nobody has
a reason to use.

---

## Where this stands today

Shipped and verified, not aspirational:

- **The game works.** Deterministic lockstep sim, 3D arena, rigged units, real
  human matchmaking with hash refereeing, bot fallback so a solo demo never
  stalls.
- **The program is live on devnet** (`BnLD…FxeP`). Mint, stake and two-step
  unstake are real wallet-signed transactions against real SPL mints. The
  eligibility gate is observable: two seeded coins are rejected, one on age, one
  on liquidity.
- **Battles run on a MagicBlock ephemeral rollup** (`3G4Gidvj…5g6N`, live on
  devnet). Card plays and state-hash checkpoints are written to the rollup and
  committed back to Solana. 23/23 end-to-end including hosted router placement.
- **Clans** are a full stack — 48-assertion API suite, browse/found/join, the
  lend loop, crown ladder, roles and leader succession.

Not built: session keys, VRF, and everything in this document.

---

## The one mechanic everything waits on

**Today a card's power comes only from staked USD. That makes every coin
interchangeable.** $100 staked in $BONK produces exactly the same card as $100
staked in a coin that launched five minutes ago.

Which means there is no reason to want a *specific* coin — and therefore no
reason for a marketplace, a launchpad, or a meta to exist. Every ambitious idea
below is standing on this one hole.

### Phase 1 — Live meme meta

> A coin's market performance changes how its card fights.

```
coin +40% today  →  its card fights ~15% stronger today
coin dumps       →  its card weakens
```

The moment this ships, four things become true that are not true now:

1. **Coins stop being interchangeable.** Cards become scouting, not just staking.
2. **Holding early pays twice** — in price *and* in win rate.
3. **The meta moves on its own.** Nobody balances it; the market does. No other
   card game has a live external balance patch.
4. **A launchpad becomes coherent**, because buying a coin early now means
   getting a strong card before anyone else knows.

Deliberate constraints, so this does not become pay-to-win: the swing is bounded
(±15% is the working figure), it applies to stats and never to elixir cost, and
the existing diminishing stake curve stays load-bearing. **Whales buy an edge,
never the win** survives this change or the change does not ship.

Cost: small. The server's `/api/coins` feed already carries `change24h`. The work
is the oracle path that makes it trustworthy onchain, not the mechanic.

---

## Phase 2 — Private decks (MagicBlock PER)

The second MagicBlock product, and the one that fits without inventing a new
product surface.

Today both players commit a `deck_hash` at match start — a hand-rolled
commitment scheme. A Private Ephemeral Rollup does that properly: **the deck
lives inside a TEE-backed rollup and the opponent cannot read it until reveal.**

Why it matters: deck-sniping is a real problem in every competitive card game.
Right now a determined opponent can correlate an address with its past decks.
Private decks make that structurally impossible rather than merely inconvenient.

Why it is the right second product:

- Zero custody of user funds — the failure mode is a delayed reveal, never a lost
  stake
- Slots into a match flow that already exists
- Small enough to finish, which matters more than it sounds

Implementation shape: delegate the deck-commitment PDA to the TEE validator
(`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` — the same identity on devnet and
mainnet), create its `EphemeralPermission` on the rollup, reveal at match start
by committing back. Note that the TEE region does not serve an RPC router by
design, so placement is named rather than discovered.

---

## Phase 3 — The launchpad

Cut from the hackathon on purpose. It is a good business and a bad ten-day
project: it custodies real money, needs a two-sided market we do not have, and —
critically — it is worthless until Phase 1 makes coins non-interchangeable.

### What it is

A launchpad where **allocation is gated on gameplay**, and the order book is
invisible until it fills.

- **Entry is earned.** Your deck power (later: crowns, matches won) decides
  whether you may buy and how much. Proven onchain by passing your eight card
  PDAs — the same mechanism `create_match` already uses.
- **The book is shielded in a PER.** Nobody can see the fill level or the
  allocation table, so there is nothing to snipe and no pending flow to
  front-run.
- **Bonding reveals everything at once** and migrates liquidity to a Solana pool.
- **The coin becomes instantly playable.** It registers in `CoinInfo` at bonding,
  legitimately skipping the 48-hour age gate — because bonding *is* the proof of
  liquidity and distribution that gate was asking for.

### The architectural rule that makes it safe

**Money never rides the rollup.** The book is delegated; the vault holding SOL
and token supply is not. A stalled rollup delays a reveal — it can never strand
deposits. This is the same rule that makes the match escrow safe, and it survives
PER unchanged.

One consequence worth stating, because it shapes the mechanism: an ER transaction
cannot move base-layer lamports. So deposits are **uniform tickets** paid on
Solana, while the *bid* and *allocation* stay private in the rollup. The vault
balance reveals how many people are interested and nothing else. That makes it a
sealed-bid uniform-price auction rather than a continuous bonding curve — which
is strictly harder to snipe anyway.

### Why anyone would launch here rather than pump.fun

Not the fees. **The holders.** A pump.fun buyer sells in twenty minutes. A
Mempire buyer stakes into a card, which locks the tokens behind a 72-hour
two-step unstake and costs them card levels to exit. Creators are not buying
distribution — they are buying *holders who have a reason to stay*.

### The art question, answered

A launchpad implies arbitrary coins, which sounds like an unbounded art problem.
It is not: **3D models are keyed by archetype, not by coin.** A new token hashes
to one of six archetypes and reuses an existing rig; its logo comes from its own
token metadata. A brand-new coin needs zero new art.

---

## Phase 4 — Mainnet

None of this touches mainnet without all four:

| | Why |
|---|---|
| **Program security review** | Real money moves through the escrow and the vaults |
| **Treasury multisig (Squads)** | Never launch with a single-key treasury |
| **Geo-blocking + ToS** | A rake on a wagered pot is real-money skill gaming, and it is regulated |
| **Real price oracle** | Replaces the devnet mock — and Phase 1 makes the oracle load-bearing rather than cosmetic |

The rake is the part that needs a lawyer, not an engineer. Devnet is fine
indefinitely; mainnet is a legal decision before it is a technical one.

---

## Unit economics

Why the launchpad is acquisition and the rake is revenue. One launch, working
numbers:

| | |
|---|---|
| Launch raises | 85 SOL |
| Launch fee (2%) | **1.7 SOL** |
| ~120 of 200 buyers mint a card @ 0.02 | **2.4 SOL** |
| Those players wager ~240 SOL in their first weeks | |
| Rake (10%) | **24 SOL** |
| **First-cycle total** | **≈ 28 SOL** |

The launch earns 1.7 once. The players it delivers keep paying rake for as long
as they play. **pump.fun monetises a buyer once and loses them; we recruit them
into a game that takes 10% of every match they ever play.**

The economy has two distinct sources of money, which is what makes it durable:

```
pots        → zero-sum minus rake  → funds the house
allocations → positive-sum         → funds the players
```

A casual player can lose small pots all month and still come out ahead because
their crowns earned a real allocation. That is the part play-to-earn games never
had: **no emissions.** A pot is 0.05 + 0.05 in, 0.09 out, 0.01 raked. The game
never needs new money to pay old players. This is poker's shape, not Axie's, and
it is why it does not collapse when inflows slow.

---

## Also worth building

Ordered by value per unit of effort, from `ROADMAP.md`:

- **Session keys** — no wallet popup per card play. `PRODUCT.md` already promises
  "zero wallet popups once a match starts"; the onchain path cannot deliver that
  today. This is a claim-versus-reality gap, not a feature.
- **VRF chest rolls** — chest tiers are currently decided by `Math.random()` in
  the browser, and gems buy chest skips. We sell access to a loot box whose odds
  nobody can verify. MagicBlock VRF makes the roll provably fair, and the
  request→callback shape maps onto the existing shake→burst ceremony.
- **cNFT card layer** (Bubblegum) — makes cards tradeable, which unlocks a
  marketplace and a 5% royalty that compounds forever.
- **Tournaments** — 8% of every pool, and they scale without us operating
  anything.
- **Coin sponsorship** — "Coin of the Week". B2B; coin treasuries become
  customers. Highest revenue ceiling on the list.
- **Replays** — nearly free. The input log *is* the replay.

---

## Deliberately not on this list

- **A token.** The economy works without one, and adding one turns a working
  rake into an emissions problem.
- **Play-to-earn mechanics.** The graveyard is full of them for one reason: the
  earning was funded by new players rather than by value created.
- **Competing with pump.fun head-on.** They have the liquidity and the network
  effect. The wedge is game-native launches, not a better bonding curve.
