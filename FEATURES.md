# Mempire — Monetization Design

Fifteen features, each one a place money changes hands. Ordered by **revenue per
unit of build effort**, so the first five carry the hackathon and the rest are
the roadmap a judge can see is real.

Every feature obeys three rules:

1. **It never sells power directly.** Whales already buy an edge by staking; a
   second paid power lever would collapse matchmaking and the game dies. Money
   buys *access, speed, cosmetics, and information* — never stats.
2. **It rides the rails we already built.** Cards, stake vaults, match pots and
   the rake exist. Most of these are a new reason to touch them.
3. **The fee is stated where it applies.** A hidden cut is a one-time revenue
   event; a visible one is a business.

---

## The core loop already earns

| Source | Rate | Notes |
|---|---|---|
| Battle rake | **10%** of every pot (5% on a draw) | The engine. Scales with player count and stake tier. |
| Card mint | **0.02 SOL** | Every card ever created. |
| Unstake | **2%** | Discourages stake-farming, charges the exit. |

At 1,000 daily matches averaging the 0.25 SOL tier, the rake alone is
**50 SOL/day**. Everything below either raises that number or adds a second
curve on top of it.

---

## Tier 1 — build for the hackathon

### 1. Chests (the compounding loop) ⭐
Win a battle, earn a chest. Chests hold cards, coin dust, and Gems. They unlock
on a **real-time timer** (15 min → 3 h → 8 h), and you can hold only four.

**Why it earns:** the timer is the product. Players pay Gems to skip it, and
they pay *because they want to keep playing right now*. This is the single
highest-grossing mechanic in the genre and it costs us nothing to run.

- Silver (15 min) · Golden (3 h) · Magic (8 h) · Legendary (12 h)
- Skip cost scales with time remaining, shown before you pay
- **Revenue: Gem sinks.** Also the reason players return on a schedule.

### 2. Gems — the one hard currency ⭐
A single premium token bought with SOL. Gems skip chest timers, enter tournaments,
reroll shop offers, and buy cosmetics. **Gems never buy stats.**

- Bundles: 80 / 500 / 1,200 / 2,500 Gems
- Bought with SOL at a published rate; the treasury takes the spread
- **Revenue: direct sale.** The backbone every other feature draws on.

### 3. The Shop — daily card offers ⭐
Four coin-cards a day, priced in Gems and SOL, rotating every 24 h. One free
reroll, further rerolls cost Gems.

**Why it earns:** it converts *wanting a specific coin* into a purchase. A player
who holds no $BONK but wants the $BONK card has no other route.

- **Revenue: Gem sink + mint fee + a margin on the card.**

### 4. Card detail sheet with live market data ⭐
Tap any card: the coin's real pump.fun art, live price, FDV, 24 h change,
liquidity, holder count, plus its battle stats at current level and what the
next level costs.

**Why it earns:** it isn't a fee — it's the *reason the other fees convert*.
Seeing "$PNUT is up 12% today, your card is level 4, level 5 costs $100" is what
makes someone stake. It also makes Mempire a genuinely useful meme-coin browser,
which is a retention story on its own.

### 5. Tournaments — entry fee, prize pool, our cut ⭐
Player-created brackets. Creator sets the entry fee (SOL or Gems) and the size;
we take **8%** of the pool and charge Gems to create a private one.

- Open tournaments: free to join, sponsored prize, we take a listing fee
- Private: creator pays Gems, invites their community
- **Revenue: 8% of every pool + creation fees.** Scales without us running anything.

---

## Tier 2 — the obvious next wave

### 6. Season Pass
A 10-week ladder of rewards on two tracks: free, and paid (a flat SOL price).
Paid unlocks a cosmetic arena skin, bonus chest slots, and Gem drops.

**Revenue: recurring seasonal purchase** — the most predictable line on the sheet.

### 7. Card Fusion
Burn two same-archetype cards plus a fee to mint one stronger card that inherits
the higher-market-cap coin's identity, with a 15% stat bonus.

**Revenue: 0.05 SOL fusion fee + it destroys card supply**, which supports the
value of everything still held.

### 8. Cosmetics: arena skins, unit skins, emotes
Purely visual. A gold-plated arena, a crowned $BONK, a laughing-Wojak emote you
can spam after a tower falls.

**Revenue: Gem sink with no balance risk.** The safest money in games.

### 9. Coin sponsorship — sell the arena to the coin teams ⭐
A meme coin project pays to be **Coin of the Week**: their art on the arena
banners, a boosted drop rate in chests, a featured Shop slot.

**Why it's the sleeper:** meme coin teams already spend heavily on marketing and
have treasuries. We are a captive audience of exactly their target user. This is
B2B revenue with no player-facing cost at all, and it could out-earn the rake.

**Revenue: direct sponsorship, priced per week.**

### 10. Spectator mode with tipping
Watch live high-tier matches. Tip a player in SOL; we take 5%.

**Revenue: 5% of tips + it makes top players want an audience**, which makes them
play more.

---

## Tier 3 — depth once there is a population

### 11. Clans and Clan Wars
Clans of 50. Members donate cards to each other; Clan Wars stake a shared pot.

**Revenue: clan creation fee, war entry rake, donation fee.** Mostly this exists
because clans are the strongest retention mechanic in the genre.

### 12. Card marketplace with royalties
Cards are cNFTs, so they trade. We take a **5% royalty** on every secondary sale,
forever.

**Revenue: 5% of all secondary volume** — the annuity. It compounds as the
collection grows and costs nothing to operate.

### 13. Ranked ladder with seasonal SOL prizes
Trophy-based ranking, seasonal reset, top-100 split a prize pool funded by a
slice of the rake.

**Revenue: indirect but large.** Ranked players battle far more often, and every
battle is raked.

### 14. Live meme meta — the coin market moves the game
The top pumping coins of the day get a temporary in-battle boost, published in
advance. Your deck's strength genuinely tracks the market.

**Revenue: indirect, and it is our moat.** No other card game can do this,
because no other card game's cards are real assets. It also drives daily return
visits and makes the Shop convert.

### 15. Creator codes and referrals
Streamers get a code. Their viewers' purchases pay them 5%; we keep the rest and
gain the user.

**Revenue: negative-cost acquisition** — we only pay on a sale that happened.

---

## Why this wins rather than just earning

Judges see a lot of games with a token bolted on. The argument here is narrower:

- **The rake is real revenue on day one**, not a future token emission.
- **Feature 9 is a business model nobody else has.** Being the arena where meme
  coins fight makes coin treasuries our customers, not just their holders.
- **Feature 14 is a mechanic nobody else can copy.** It only works if the cards
  are genuinely the assets, which is the whole architecture.
- **Nothing sells stats.** The economy survives contact with whales, which is the
  question every judge asks about a pay-to-play game.

## Build order

Shipping now: **1, 2, 3, 4** — chests, Gems, Shop, card detail. Together they
close the loop: win → chest → open → want a card → Shop → stake → battle.

Next: **5** tournaments, then **9** sponsorship, because that is where the
revenue ceiling actually lifts.
