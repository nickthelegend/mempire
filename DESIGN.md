# Design

<!-- Durable visual authority for Mempire. PRODUCT.md owns product truth. -->

> **Current world: Royale Arcade.** The sections below describing a near-black
> violet "Solana Royale" are superseded — that world was replaced after the
> reference screenshots landed. Live tokens are in `app/src/styles/tokens.css`
> and mirrored for Three.js in `app/src/lib/palette.ts`.

## World: Royale Arcade

Clash Royale's chrome carrying Mempire's content. A quilted royal-blue field,
carved wood panels, and fat buttons that physically depress into their own base
edge. Display type is chunky, uppercase, and heavily outlined. Solana purple and
teal survive as the energy accent; royal gold still means exactly one thing —
SOL is moving.

| Role | Token | Rule |
|---|---|---|
| Field | `--blue` on `.quilt` | Diamond harlequin pattern in CSS, not a texture — crisper and seam-free. |
| Panels | `.panel` | Wood texture + `--bevel-out` + a hard base edge. All chrome is carved. |
| Recessed content | `.well` | `--bevel-in`. Content sits *inside* panels, never floats on them. |
| Controls | `Pill` with `tone` | gold = primary, blue = secondary, green = collect, red = destructive. |
| Money | `.money` | Display face, gold, dark stroke, always `nowrap`. |
| Elixir | `--elixir` | Magenta. Never gold — gold is money only. |

**Legibility law.** **12px is the floor for every readable string**, enforced in
`tokens.css` rather than left to each call site. On a patterned field, smaller is
not "small text" — it is invisible text. Body copy carries a shadow, text on wood
uses `--dim-on-wood` rather than the blue `--dim`, and `.mono` keeps its parent's
size (tighter tracking instead of a smaller size, because shrinking it dragged
nested strings under the floor). Card frames derive type size from card width, so
those minimums are floored too. Only purely decorative glyphs may go smaller, and
only when an `aria-label` carries the meaning instead.

**Bevel law.** Nothing interactive is a flat rectangle. Raised things get a top
highlight plus a hard base edge; pressed things translate into that edge.

---

## Superseded: Solana Royale

A royal court built by degens. The throne room of the meme empire: near-black void, royal purple
architecture, Solana's purple→teal energy running through it like magic, and gold that appears
**only** when money is on the line. Regal grandeur played straight, undercut by meme-coin
irreverence in the details. Never generic-web3 (no floating orbs, no abstract blobs); the royal
metaphor is always literal — crowns, thrones, banners, gilded frames, coins.

## Color

| Role | Value | Rule |
|---|---|---|
| Void (page ground) | `#08060F` | The world outside the column. Subtle radial purple glow behind the column; otherwise empty. |
| Surface | `#110D1C` | Panels, cards, sheets. |
| Surface-raised | `#191327` | Hover/active panels, list rows. |
| Border | `#2A2140` | 1px hairlines; gold borders reserved for money. |
| Royal purple (primary) | `#9945FF` | Interactive: buttons, links, focus, selection. Solana brand purple. |
| Teal (live) | `#14F195` | Live/online/success states, win numbers, "in battle" pulses. Solana brand teal. |
| Gradient | `#9945FF → #14F195` | The Solana beam. Primary CTA fills, energy VFX, elixir bar, progress. Always this direction (left→right / bottom→top). |
| Royal gold | `#F0B90B` (hi `#FFD75E`) | **Money moments only**: pot amounts, stakes, fees, victory, card level pips, crowns. Never decorative elsewhere — gold means SOL is moving. |
| Loss red | `#FF4D6D` | Damage, defeat, destructive confirms. Never the accent. |
| Text | `#F4F1FB` | Primary. |
| Text-dim | `#8E85A8` | Secondary, labels. |

Strategy: Restrained-dark base + Committed gradient accent. Purple carries interaction; teal carries
liveness; gold carries money. The three never swap jobs.

## Typography

| Face | Job | Rules |
|---|---|---|
| **Lilita One** (Google) | Display: screen titles, victory/defeat, the BATTLE call | Always uppercase, ≥19px. Chunky arcade-sign lettering with a dark stroke and a hard 2px drop — the same grammar as the generated logo. Never on body text. |
| **Hanken Grotesk** (Google) | Everything operable: buttons, labels, body, nav | Buttons: 700–800, 13–14px, caps, +0.08em tracking. Body: 400/500 15px. |
| **Martian Mono** (Google) | Data: balances, stakes, timers, tick counters, addresses | Tabular numerals. Money values always mono + gold, always `white-space: nowrap`. |

`.display--gold` fills display type with the gold metallic gradient over a dark
stroke. This is the world's native arcade-lettering device, not decorative
gradient text — the wordmark is built the same way. It is the **only** place a
gradient may touch type.

The wordmark is the generated lockup at `app/public/art/logo.png`, never
set in live type.

## Layout law

- Single centered column, `max-width: 430px`, full viewport height, on the void. Side gutters stay
  empty (reserved: future ads) with only the radial glow. On ≤430px screens the column IS the screen.
- The whole app is a portrait phone experience; desktop views it like an arcade cabinet.
- Bottom tab bar (in-column): **Arena · Cards · Deck · Empire** (profile/history). Battle runs
  full-column, chrome hidden.
- Spacing: 4px base grid; section rhythm 24/32; card padding 16.
- Radii: panels 16, buttons 999 (pills, per reference), cards 12, the 3D canvas 0.

## Component character

- **Primary CTA**: pill, Solana-gradient fill, dark text `#08060F`, faint outer glow
  (`box-shadow: 0 0 24px rgba(153,69,255,.35)`). One per screen.
- **Money row / pot display**: gold mono numbers on `Surface`, thin gold border, coin icon.
  A pot readout is the most sacred component in the app — plain, unambiguous, never abbreviated.
- **Cards (the NFT kind)**: 3:4 portrait, gilded frame (thin gold bevel), coin logo top-center in a
  round seat, archetype icon bottom-left, level as 1–10 gold pips bottom edge, name in caps.
  Card rarity/power communicated by frame intensity, not rainbow rarity colors.
- **Tier badges**: crowns (1–4 crowns for the 4 stake brackets).
- **Elixir bar**: horizontal Solana-gradient fill with tick marks at each integer, current value in
  mono at the right end.
- **Empty states**: one line of degen copy ("bag is empty, anon") + one plain action. Never a blank panel.

## Motion

- Transitions: 180–240ms, `cubic-bezier(.2,.9,.3,1)`; screen pushes slide within the column.
- The gradient never animates position on static screens (battery); it pulses only on live states
  (matchmaking spinner, live pot).
- Money moments get weight: pot settle = gold coin burst + count-up in mono; defeat = desaturate dip.
- Battle VFX budget: GPU particles ≤ 200; no full-screen flashes >80ms.

## Voice (binding examples)

- Buttons: `BATTLE`, `STAKE`, `CLAIM`, `MINT CARD`, `LOCK DECK` — one word where possible.
- Victory: `POT SECURED` + amount. Defeat: `REKT` + amount lost (mono red).
- Financial confirms are plain English + exact numbers; slang never appears on a confirm.

## Game-asset style (frozen)

All generated art follows the byte-identical STYLE FORMULA (see `design/assets.csv` header).
Arena = violet-black stone, teal energy river, gold-trimmed towers, purple banners.

Shipped generated assets live in `app/public/art/` — the wordmark, 12 round coin logos
(gold-rimmed chibi faces), and 6 gold archetype crests. They are sliced from grid sheets by
`design/slice.py`, which keys out the black surround and writes transparent PNGs. Regenerate
with `design/gen.sh <name> <aspect> "<prompt>"`, then re-slice.

Coin logos carry their own gold rim, so `CoinBadge` adds no border — only a drop shadow.
Archetype crests replace the emoji glyphs everywhere; never reintroduce emoji for archetypes.

## Sound

`app/public/sfx/` — deploy, hit, tower, victory, defeat, coin, plus a battle music loop.
Routed through `src/lib/audio.ts`: pooled elements so rapid hits never cut each other,
a persisted mute honoured by the in-battle toggle, and every play call swallowing
autoplay rejection. Music starts on match start and stops on settle or dismiss.

## Battle feel (non-negotiables)

- Cards **drag** onto the arena; a ghost tracks the finger and a ring marks the drop —
  teal when legal, red on the enemy half. A tap arms the card as a keyboard/fallback path.
- A felled tower plays a crown, a sound, and a screen shock. The shock is driven by
  `element.animate()` on a ref — never by remounting, which would drop the WebGL context.
- Units are **rigged** (KayKit CC0 chibi) and driven by a real AnimationMixer:
  Idle, Walk, Attack, Hit and Death, cross-faded on state change. A genuine rig
  beats prettier static geometry here — the eye reads limbs moving.
- Units are scaled well above their collision footprint on purpose. At this
  camera height a physically honest unit is a dot, and knowing who is on the
  field matters more.
- Per-unit cloned materials are disposed on death and unmount. Shared geometries
  are never disposed in an effect cleanup — StrictMode double-invokes it in dev.
