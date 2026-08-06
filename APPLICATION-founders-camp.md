# MagicBlock Founders Camp — application answer

> Draft for the "further information" field. Everything below is verifiable
> today; the one section marked **[YOUR BACKGROUND]** is the part only you can
> write.

---

**Mempire — mempire.fun · play.mempire.fun (live on devnet)**

## The thesis

Every token holder has a position they can do nothing with except look at it.
Mempire turns it into a roster.

You connect a wallet, and the coins you actually hold become the fighters —
$BTC is a gold knight, $PEPE is a trenchcoat frog. You mint them into cards,
stake more of the coin into a card to level it, build a deck of eight, and drop
them on a live battlefield against another player's bags with real SOL on the
match. Winner takes the pot.

The bet underneath it: onchain games have mostly failed for one of two reasons.
Either they are not really onchain — a web2 game with a mint attached — or they
are turn-based, because an L1 cannot run a real-time loop. Ephemeral rollups
remove the second constraint entirely, and the moment they do, the interesting
question becomes what a game can do that a web2 game structurally cannot. My
answer is: make the chain state the game content. Your holdings are your deck.
That is not a feature a Supercell clone can copy, because it requires the
player's actual portfolio to be readable and stakeable.

Every design rule follows from keeping that chain honest. A coin under $25k
liquidity or younger than 48 hours is refused, so nobody mints a god card from
a token they launched this morning. The archetype is `hash(mint) % 6` — global,
permanent, no rerolls — so $BTC is the same class of fighter in everyone's deck.
The level curve is `1 + 0.6·√((lvl−1)/9)`, deliberately brutal at the top, so a
whale buys an edge and never a win.

## Why MagicBlock is load-bearing, not decorative

The simulation is deterministic lockstep at **20 ticks per second**, fixed-point
integer maths, with a state hash every 40 ticks. That product cannot exist on an
L1. I am not using ERs because they were on a sponsor list — remove them and
there is no game.

All three surfaces are integrated and running on devnet:

- **ER** — match state delegates to an ephemeral rollup and commits back, so the
  match is onchain and still real-time. Escrow and payout deliberately stay on
  Solana itself, so a delegated match log can never strand a pot.
- **PER** — the match log is sealed to the two seats. Before this, any third
  party could open a live match's permission and read both hands two ticks
  before they resolved. Now it is seat-only.
- **VRF** — chest tier *and* the specific cards inside are both derived from the
  oracle seed, and the seed is shown in the open ceremony so a player can check
  the roll. A derivation nobody can see the input to is not a derivation.

Built on `ephemeral-rollups-sdk` 0.16.2 with `anchor-compat`. Three programs
deployed to devnet:

```
mempire         BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP
mempire-rollup  3G4GidvjQd3yQK4bqZfem8Kkmcboygze42RcjrXg5g6N
mempire-amm     7tM95L7TooveTGAtmo6nRyJRQpSVADN3DPaagJmSp8CP
```

Also live: **$MEMPIRE**, an SPL token with a real constant-product AMM against
Circle's devnet USDC — x·y=k, 0.30% to LPs, u128 intermediates, `MINIMUM_LIQUIDITY`
genuinely unwithdrawable. Not a mocked swap screen.

## What is actually built

118 commits since 30 July. Solo.

- 64 fighters, each with original art, a name, a written story, and a
  deterministic trait derived from its mint, so no two cards of the same
  archetype play alike.
- Real-time 3D arena (React Three Fiber), deterministic sim shared by both
  clients, match voids and both stakes return if the two ever disagree.
- Session keys, so there are no wallet popups mid-battle.
- A deployed API with an **ed25519 signature required on every mutating route**,
  over a timestamped per-action message. Clans, ranked and the leaderboard are
  live behind it.
- mempire.fun (marketing, 64 shareable card pages with OG cards) and
  play.mempire.fun (the game).

## Evidence I build carefully, not just fast

I ran five parallel audits of my own repo and **published every finding,
including the ones I had not fixed yet**, with severity and exploit path. The
first pass found real pot theft: a single signer could set the winner and take
the pot without playing. Also permissionless delegation, stranded escrow, and a
relayed opponent deck that was unvalidated — an out-of-range archetype made
every card free on both clients and hashed identically, so no desync fired.

All of them are now closed. `AUDIT.md` currently reads *Open — chain: None.
Open — client: None.* Each fixed finding has a test in `e2e-security.ts` that
attempts the original exploit and asserts the refusal.

Verified against the deployed programs:

```
e2e-amm            18/18   real USDC, real curve
e2e-per-vrf        21/21   delegation, seal, oracle callback
e2e-full-flow      32/32   16 real transactions
e2e-security        8/8    the exploits, refused
e2e-two-browsers   14/14   against production
AMM unit tests     14/14
client suites      34/34
live E2E           92/92   both sites, mobile + desktop
```

The last one matters most to me: two browser processes, two funded keypairs,
nothing but clicks — claim the starter kit, mint a deck, queue, play, settle.
Match #19 is `Settled` on devnet with the escrow emptied and 0.0947 SOL returned
against a 0.100 pot. That is the tie rake, taken by the program and observed on
the ledger rather than in the UI's own words.

## [YOUR BACKGROUND]

*Replace this section. Worth covering: what you have shipped before and whether
anything reached real users; your background in games, graphics, or Solana
specifically; whether you have worked solo or led a team; anything that explains
why you can go from zero to this in a week. If you have shipped a product that
made money or held users, say the numbers. If this is your first serious
project, say that plainly — building this in eight days solo is its own
argument.*

## What is honestly not done

Devnet only; nothing has touched mainnet. No real users yet — the ladder is
seeded and the opponents in Practice are a bot. The economy is designed but
untested against people trying to break it for money rather than for a test
suite. And it is one person, which is the constraint I most want to fix.

## What I would use the ten days for

Three things I cannot do alone:

1. **Mainnet, correctly.** The audit closed every finding I could find. I want
   your engineers to try to break the escrow and settlement path before real
   money is on it, not after.
2. **The economy under adversarial load.** The rake, tier ladder and level curve
   have never met people optimising against them. Ten days in a room with other
   founders is the fastest way to find out where they bend.
3. **Turning it into a business.** I can ship. I have never raised, and I do not
   know what a serious Solana gaming raise looks like. That is the specific gap
   Demo Day and the fundraising track would close.

Play it: **play.mempire.fun** — connect a wallet or hit *Play as guest* and you
are in a match in about fifteen seconds.
