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
- **The program is live on devnet** (`BnLD…FxeP`). Minting a card (0.02 SOL),
  merging a duplicate to promote it, escrowing a pot and settling it are real
  wallet-signed transactions. The eligibility gate is observable: two seeded
  coins are rejected, one on age, one on liquidity.
- **The game never touches a player's holdings.** Staking is gone — the
  instructions, the vaults, the unstake fee and the cooldown were removed, and
  every token that had been staked was returned to its owner first. Coins,
  stocks and crypto are the roster, not collateral. The only asset anyone risks
  is the SOL they choose to put on a match.
- **Cards level by winning.** Win a match, earn a chest; chests drop duplicates;
  merging a duplicate promotes the card, 1 → 10. Nothing on the fee list buys a
  level, which is the constraint every idea below has to survive.
- **Battles run on a MagicBlock ephemeral rollup** (`3G4Gidvj…5g6N`, live on
  devnet). Card plays and state-hash checkpoints are written to the rollup and
  committed back to Solana. 23/23 end-to-end including hosted router placement.
- **PER and VRF are wired, not just deployed.** The match log is sealed inside an
  ER-local permission whose only members are the two seats, and chest tiers come
  from the MagicBlock VRF oracle with the 32 bytes stored so anyone can
  re-derive the drop. 20/20 against devnet and the live oracle.
- **Session keys work.** One wallet signature at match start authorises a
  temporary signer scoped to one seat, one match, 30 minutes at most — then no
  popups for the rest of it.
- **Clans** are a full stack — 48-assertion API suite, browse/found/join, the
  lend loop, crown ladder, roles and leader succession.
- **Mainnet is costed rather than hypothetical.** The lean build
  (`--no-default-features`, 463,456 bytes) deploys for 3.23 SOL, and that is a
  refundable rent deposit, not spend. `nft` (Metaplex 1-of-1 cards) and `rollup`
  (ER + VRF chests) are cargo features that can be added later with
  `solana program extend`; the full build is 704,432 bytes / 4.90 SOL.
  Settlement behaves identically with or without the rollup. `MAINNET.md` has
  the sequence.

Not built: a marketplace, a launchpad, and everything else in this document.

---

## The one mechanic everything waits on

**Two cards of the same archetype and level fight identically, whatever their
coins did today.** A card's identity is fixed by its mint — `fnv1a(mint) % 6`
picks the archetype, the token's own metadata supplies the art — and its power
comes from levels earned by winning. Both are settled before the match starts.
Nothing $BONK does this week reaches the arena.

That is correct for fairness and empty for meaning. The roster is a cast of
characters whose market lives happen somewhere else, so there is nothing to
scout, no meta that moves on its own, and nothing a launchpad could sell —
spotting a coin early gets you a card anyone else can mint for 0.02 SOL. Every
ambitious idea below is standing on this one hole.

### Phase 1 — Live market meta

> A coin's market performance changes how its card fights.

```
coin +40% today  →  its card fights ~15% stronger today
coin dumps       →  its card weakens
```

The moment this ships, four things become true that are not true now:

1. **Coins stop being interchangeable.** Two Tanks stop being the same Tank, and
   building a deck becomes reading the market.
2. **Reading it early pays inside the game** — and it pays without anyone having
   to hold anything. The card costs 0.02 SOL whether or not you own the token,
   so this rewards scouting, not bags.
3. **The meta moves on its own.** Nobody balances it; the market does. No other
   card game has a live external balance patch.
4. **A launchpad becomes coherent**, because spotting a coin early now means
   fielding a strong card before the rest of the ladder notices.

Deliberate constraints, so this does not quietly reintroduce a way to buy power:
the swing is bounded (±15% is the working figure), it applies to stats and never
to elixir cost, and the earned level curve stays the dominant term. Level is the
thing nobody can purchase; a market modifier large enough to make that untrue is
a modifier that does not ship.

Cost: small. The server's `/api/coins` feed already carries `change24h`. The work
is the oracle path that makes it trustworthy onchain, not the mechanic.

---

## Phase 2 — Private decks (the rest of PER)

PER already shipped, but for the play log rather than the deck: `seal_log` /
`reseal_log` / `unseal_log` on the rollup, an `EphemeralPermission` whose only
members are the two seats, and no base-layer permission account at all. The deck
is the part still in the open.

Why it matters: deck-sniping is a real problem in every competitive card game,
and Mempire's decks are unusually legible. `create_match` derives the deck
commitment onchain from the eight card PDAs it locks — deliberately, because
accepting the hash from the caller let a player bracket in on eight level-1 cards
and then hand the simulation eight level-10 ones. The price of that fix is that
the lock is a public write: anyone can read which cards a wallet just committed.

So this is a larger change than it looked before. Hiding the hash is not enough,
because the lock itself is the leak — what has to move behind the TEE validator
(`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, the same identity on devnet and
mainnet) is the card-lock step, with the reveal committed back at match start.
Note that the TEE region does not serve an RPC router by design, so placement is
named rather than discovered.

Two things it must not cost:

- **Zero custody.** The failure mode stays a delayed reveal, never a lost stake.
- **Settlement's account list.** `end_log` deliberately does not depend on the
  permission, so a sealing change can never add a way for a paid match to fail
  to pay out. Whatever replaces the public lock keeps that property.

---

## Phase 3 — The launchpad

Cut from the hackathon on purpose. It is a good business and a bad ten-day
project: it custodies real money, needs a two-sided market we do not have, and —
critically — it is worthless until Phase 1 makes coins non-interchangeable.

### What it is

A launchpad where **allocation is gated on gameplay**, and the order book is
invisible until it fills.

- **Entry is earned**, and since staking was removed that is now literal. Deck
  power is the sum of card levels, and levels come only from winning, so gating
  allocation on deck power is gating it on matches won rather than on deposits.
  Proven onchain by passing your eight card PDAs — the same mechanism
  `create_match` already uses.
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

Not the fees. And no longer lockup, either: nothing in Mempire holds a token, so
any pitch that depends on a cooldown keeping holders in place is a pitch we
cannot make and should not imply.

What is left is **duration of attention**. A pump.fun buyer's relationship with a
coin ends at the sell button. A Mempire launch puts the coin on the roster as a
fighter with art, an archetype and a place in the ladder, and Phase 1 gives its
community a second reason to watch its chart. Sold honestly, that is
distribution into a game people come back to — not captivity, and weaker than a
lockup would have been.

### The art question, answered

A launchpad implies arbitrary coins, which sounds like an unbounded art problem.
It is not: **3D models are keyed by archetype, not by coin.** A new token hashes
to one of six archetypes and reuses an existing rig; its logo comes from its own
token metadata. A brand-new coin needs zero new art.

---

## Phase 4 — Mainnet

Mainnet for the base game is no longer a cost question — `MAINNET.md` prices the
lean build at ~3.2 SOL, nearly all of it recoverable rent. What gates it is the
list below, and everything in this document adds money paths that make that list
stricter rather than shorter:

| | Why |
|---|---|
| **Program security review** | Real money moves through the match escrow, and the launchpad would add a vault of its own |
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

- **Marketplace + royalty** — under the `nft` feature a card already mints as a
  Metaplex 1-of-1 with 500 basis points of royalty written into its metadata, so
  what is missing is the venue, not the plumbing. A place to trade cards turns
  that 5% into an annuity that costs nothing to run.
- **Bubblegum cNFT drops** — the cheap layer underneath, for the cards chests
  hand out by the thousand. Independent of the marketplace, not a prerequisite
  for it.
- **Tournaments** — 8% of every pool, and they scale without us operating
  anything.
- **Coin sponsorship** — "Coin of the Week". B2B; coin treasuries become
  customers. Highest revenue ceiling on the list.
- **Replays** — nearly free. The input log *is* the replay.

Two items that were on this list have since shipped, and are worth recording
because they were both claim-versus-reality gaps rather than features. Session
keys: `PRODUCT.md` promised "zero wallet popups once a match starts" while the
onchain path could not deliver it, and now one signature at match start covers
the whole match. VRF chests: tiers were decided by `Math.random()` in the browser
while the shop sold skips into them, which is selling access to a loot box whose
odds nobody could verify — the roll now comes from the oracle and its randomness
is stored on the chest.

---

## Deliberately not on this list

- **Emissions.** $MEMPIRE exists, but every use of it is a sink — chest skips and
  extra slots, shop purchases and rerolls, clan charters, the per-level merge
  fee. Nothing pays players for playing, and nothing sells power. A token that
  funds rewards out of its own supply turns a working rake into an inflation
  problem; that is the version that stays off the list.
- **Play-to-earn mechanics.** The graveyard is full of them for one reason: the
  earning was funded by new players rather than by value created.
- **Competing with pump.fun head-on.** They have the liquidity and the network
  effect. The wedge is game-native launches, not a better bonding curve.
