# Design brief — Mempire campaign post #2 (X / Twitter)

Make one **1600 × 900 PNG** (16:9) to attach to an X post.

Post #1 was the roster — a line-up of characters saying *your bags are your
army*. This one is the proof. Its whole job is to kill the thought a scroller
has after any crypto-game post: **"this doesn't exist yet."** So it leads with
the game actually running, not with characters standing still.

It must look like a different post from #1 at a glance. #1 was a character
line-up on a flat field; this one is a screen, in a frame, with depth.

Do not invent metrics, user counts, testimonials, partner logos, or roadmap
claims. Everything on this image must be true.

---

## The world it has to live in

Same system as post #1 — Clash Royale chrome carrying a Solana wallet.

**Palette** (copy these hexes exactly):

| role | hex |
|---|---|
| field, deep | `#0d2a5c` |
| field, base | `#14418f` |
| field, lit | `#2160c4` |
| field, pale | `#59a6f5` |
| wood | `#7a4a22` |
| wood highlight | `#b9793c` |
| wood edge | `#2e1908` |
| gold | `#ffc422` |
| gold, high | `#ffe38a` |
| gold, deep | `#a8730a` |
| Solana purple | `#9945ff` |
| Solana teal | `#14f195` |
| elixir magenta | `#d838d8` |
| ink (every outline) | `#10203f` |

**Rules, all load-bearing:**

- **The field is a quilt** — royal blue, diamond harlequin at 46px, lit from top
  centre, falling to `#0d2a5c` at the edges.
- **Gold means SOL is moving.** Never decoration.
- **Everything is carved** — hard base edge, real shadow. Nothing floats flat.
- **Every shape is outlined in ink** (`#10203f`), 3–4px, type included.
- **Display type** is Lilita One, uppercase, heavy dark stroke (~0.085em)
  painted *under* the fill, plus offset shadow `0 0.055em 0 rgba(0,0,0,.5)`.
  Stroke-under-fill is what makes it arcade lettering and not a bold web font.
  Body copy is Nunito.

---

## Assets — all on disk, all real

### The screenshots — these are the point of this post

Genuine captures of the running build. **Do not mock up a fake UI, do not
redraw them, do not "clean them up".** Their credibility is the entire idea.

```
/Volumes/Extreme SSD/Projects/mempire-landing/public/screens/battle_hero.webp   640×1205  ← the hero: a match mid-fight
/Volumes/Extreme SSD/Projects/mempire-landing/public/screens/battle.webp        640×1253
/Volumes/Extreme SSD/Projects/mempire-landing/public/screens/arena.webp         640×1253  stake tiers + modes
/Volumes/Extreme SSD/Projects/mempire-landing/public/screens/deck.webp          640×1253  eight slots
/Volumes/Extreme SSD/Projects/mempire-landing/public/screens/cards.webp         640×1253  the collection
```

All are **portrait**. Never crop a portrait into a landscape band — put it in a
device frame and let the frame be the shape.

### Fighter art — 64 characters, transparent PNG

```
/Volumes/Extreme SSD/Projects/mempire-landing/public/og/card_<ticker>.png   400×530 RGBA
```
WebP twins at `public/cards/card_<ticker>.webp`.

For this post you need only two or three, and they are used as **breakout**
figures — see composition. Best picks: `card_btc.png` (gold knight),
`card_pepe.png` (trenchcoat frog), `card_sol.png` (purple/teal cyber).

Full 64: aapl ada ai16z amd amzn apt arb atom avax bnb bome bonk brett btc cats
chillguy coin dis dot fwog googl harambe hood intc jpm link ltc matic meta mew
michi mog moodeng msft mstr near nflx nvda op pengu pepe pltr pnut popcat sbux
shib slerf sol sui tao tia trump trx tsla uni v wif wld xrp

### Logo
```
/Volumes/Extreme SSD/Projects/mempire-landing/public/brand/logo.webp   512×249 RGBA
/Volumes/Extreme SSD/Projects/mempire-landing/public/og/logo.png       240×117 RGBA
```
The only wordmark. Never set the name in type.

### Textures and supporting art
```
/Volumes/Extreme SSD/Projects/mempire-landing/public/brand/wood.webp
/Volumes/Extreme SSD/Projects/mempire/app/public/art/wood_seamless.png
/Volumes/Extreme SSD/Projects/mempire/app/public/art/arena_ground.png       192×192
/Volumes/Extreme SSD/Projects/mempire/app/public/art/icon_tank.png          128×128  (also swarm, ranged, splash, support, spell)
/Volumes/Extreme SSD/Projects/mempire/app/public/crown.svg
```

---

## Composition

**A phone, held at a slight angle, with the match spilling out of it.**

- **Background:** the quilted field, lit from top centre, corners sunk. Add a
  cool rim-light behind the device so it separates. Keep this side quiet — the
  screen is the subject.
- **The device:** `battle_hero.webp` inside a clean dark phone frame
  (`#10203f` body, subtle bevel), sitting right-of-centre, rotated ~6–8° and
  scaled so it fills roughly 70% of the canvas height. Give it a real drop
  shadow — it is an object in the room, not a flat rectangle.
- **The breakout:** one or two fighter PNGs (`card_btc.png` leading) standing
  *in front of* the frame's lower-left edge, overlapping it so they break the
  rectangle. This is the trick that stops a screenshot post looking like a
  screenshot post. Ground them with a soft contact shadow.
- **Left third — the words**, stacked, top to bottom:
  - Logo, ~280px wide.
  - Headline, Lilita One, ink stroke under fill:

    > **20 TICKS A SECOND.**
    > **ONCHAIN.**

  - Sub-line, Nunito, `#b9d4f7`, max two lines:

    > A real-time lane battler that settles on Solana.
    > Both players stake. One takes the pot.

  - Three small carved chips in a row, ink-outlined, `#59a6f5` text on
    `rgba(9,22,48,.55)`:

    > `MAGICBLOCK ER` · `VRF DROPS` · `DEVNET LIVE`

    None of these are gold — no SOL is moving in this image.
- **Foot right, small:** `mempire.fun` in gold.

Keep the left column breathing. A quilt plus a device plus breakout characters
plus four stacked text blocks will read as noise at timeline size.

## Check it at thumbnail size

X renders this near 500px wide in feed, smaller on a phone. At 25% zoom the
headline must still be readable and the device must still read as a phone
running a game. If the three chips turn to mush, drop them — do not shrink the
headline to keep them.

## Deliverable

`mempire-launch-2.png`, 1600 × 900, sRGB, under 5 MB.
