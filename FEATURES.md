# Mempire — Monetization Design

Fifteen features, each one a place money changes hands. Ordered by **revenue per
unit of build effort**, so the first five carry the hackathon and the rest are
the roadmap a judge can see is real.

Every feature obeys three rules:

1. **It cannot sell a level.** Power comes from playing and from nowhere else:
   win a match, earn a chest, open it, and a duplicate merges into a level on
   the card you keep. There is no priced upgrade anywhere in the product — no
   button that turns money into stats — so "what happens when a whale arrives"
   has a structural answer rather than a promise. He buys the same timers,
   slots and skins as everyone else and still has to win the matches. Money
   buys *time, inventory, choice and identity* — never stats.
2. **It rides the rails we already built.** Cards, match escrow, the chest rail
   and the rake exist. Most of these are a new reason to touch them.
3. **The fee is stated where it applies.** A hidden cut is a one-time revenue
   event; a visible one is a business.

---

## The core loop already earns

Every line in this table ships.

| Source | Rate | Notes |
|---|---|---|
| Battle rake | **10%** of every pot (5% on a draw) | The engine. Scales with player count and wager tier. |
| Card mint | **0.02 SOL** | Every card ever created. Holding the coin is not required, so the fee is open to every player rather than to holders. |
| Chest timer skip | **25 $MEMPIRE** | The impatience line. |
| Extra chest | **100 $MEMPIRE** | A golden chest bought outright; it lands whether or not a slot is free. |
| Shop card | **up to 250 $MEMPIRE**, or SOL | Four offers a day. |
| Shop reroll | **35 $MEMPIRE** | After the one free reroll. |
| Clan charter | **250 $MEMPIRE** | Founding a clan, once. |
| NFT royalty | **5%** | Every secondary sale of a tokenised card, forever. |

The $MEMPIRE lines are plain SPL transfers to the treasury, so the take is
readable on chain instead of asserted here.

At 1,000 daily matches averaging the 0.25 SOL tier, the rake alone is
**50 SOL/day**. Everything below either raises that number or adds a second
curve on top of it.

---

## Tier 1 — build for the hackathon

### 1. Chests (the compounding loop) ⭐
Win a battle, earn a chest. Chests pay **cards**, not currency — and a card for
a coin you already own is a duplicate, which merges into a level. They unlock on
a **real-time timer** (15 min → 3 h → 8 h), and you can hold only four.

**Why it earns:** the timer is the product. Players pay $MEMPIRE to skip it, and
they pay *because they want to keep playing right now*. This is the single
highest-grossing mechanic in the genre and it costs us nothing to run.

- Silver (15 min) · Golden (3 h) · Magic (8 h) · Legendary (12 h)
- Skip: **25 $MEMPIRE**, stated in the confirmation dialog before it is charged
- Buy a golden chest outright for **100 $MEMPIRE** — a paid chest always lands,
  even when all four slots are full
- **Revenue: the two lines above.** Also the reason players return on a schedule.

This is the retention loop and the progression at once: merging a duplicate is
the only thing that raises a level, and chests are where duplicates come from.

### 2. $MEMPIRE — the one currency ⭐
One SPL token, priced in whole units, with no second currency sitting beside it.
It skips chest timers, buys chests and shop offers, rerolls the shop and charters
a clan. **It never buys stats.**

- Acquired on the AMM: a real constant-product pool against USDC, 0.30% to LPs
- Every price is a plain SPL transfer to the treasury — no custom instruction,
  so anyone can read the token account and see exactly what the game has taken
- When the balance is short, the confirmation dialog says so and offers the swap
- **Revenue: every sink in this document.** The backbone the rest draws on.

There was a second, offchain currency here until recently. It went because the
counter players actually watched turned out to be the one that did not exist.

### 3. The Shop — daily card offers ⭐
Four cards a day, priced in **$MEMPIRE** and in SOL, rotating every 24 h. One
free reroll; after that a reroll is **35 $MEMPIRE**.

**Why it earns:** it converts *wanting a specific fighter today* into a purchase.
Anyone can mint any card in the roster for 0.02 SOL, so the Shop is not selling
access — it is selling the named card in front of you, at a fixed price, against
a clock. The rotation is the same four offers for everybody and it turns over
daily, which is what makes the visit a habit.

- A purchase mints a real card on chain; nothing is granted until the transfer
  confirms, so the shop never hands out a card it was not paid for
- **Revenue: token sink + reroll + the mint fee underneath it.**

### 4. Card detail sheet with live market data ⭐
Tap any card: the asset's real art, live price, FDV, 24 h change, liquidity,
holder count, plus its battle stats at its current level.

**Why it earns:** it isn't a fee — it's the *reason the other fees convert*.
Seeing "$PNUT is up 12% today and I do not have that fighter yet" is what sends
someone to the Shop. It also makes Mempire a genuinely useful browser for coins,
stocks and crypto, which is a retention story on its own.

### 5. Tournaments — entry fee, prize pool, our cut ⭐
Player-created brackets. Creator sets the entry fee (SOL or $MEMPIRE) and the
size; we take **8%** of the pool and charge $MEMPIRE to create a private one.

- Open tournaments: free to join, sponsored prize, we take a listing fee
- Private: creator pays $MEMPIRE, invites their community
- **Revenue: 8% of every pool + creation fees.** Scales without us running anything.

---

## Tier 2 — the obvious next wave

### 6. Season Pass
A 10-week ladder of rewards on two tracks: free, and paid (a flat SOL price).
Paid unlocks a cosmetic arena skin, bonus chest slots, and $MEMPIRE drops.

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

**Shipped first slice:** the desktop gutters the layout law always reserved now
carry carved ad boards — slot id, what the buyer gets, and `ads@mempire.fun`.
The inventory sells itself in the product instead of waiting for a deck; slot B1
pitches Coin of the Week specifically. Generated board art, live HTML copy
(generated lettering is garbled pseudo-text, and an ad slot's whole job is to be
read). Phones never see them — the game does not give up its column to an ad.

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
