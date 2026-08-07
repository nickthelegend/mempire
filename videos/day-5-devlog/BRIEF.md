---
workflow: general-video
flow: automation
storyboard: no
message: "Live PvP could not be finished at all, for two reasons that looked like other problems, and both are fixed"
destination: x-feed
aspect: 1080x1920
language: en
length: 18s
angle: devlog
---

## Intent

Day five, in public, for Solana Blitz V7. One slide, no narration, 18s vertical.

The honest headline is a confession: a real PvP match was unfinishable. Two
independent bugs, and neither presented as itself.

The first looked like a netcode void. `HUMAN_INPUT_DELAY_TICKS` was 8 — 400ms
for a card to reach the opponent — against a round trip that actually measured
1650ms, so every remote input arrived after the tick it was stamped for and
lockstep did the only honest thing available and voided. The second looked like
a settlement failure: the client reported the winner *relative to the reporter*,
so both seats always named the other, the program correctly read a dispute, and
the pot sat in escrow. Only draws ever paid, because 2 means draw from either
side and was the one value the conversion left alone.

Same structure as day three's audit post, which is why it belongs in this
series: the interesting part is not that it works now, it is what the symptom
was pretending to be.

## Assets

- `assets/gameplay.mp4` — 18s from the current build, after the fixes.
- `assets/music_battle.m4a` — the game's own battle track, −9dB under the copy.
- `assets/logo.png`, `assets/fonts/lilita-one.woff2`.

## Notes

- Figures are measured, not estimated: 1172ms to the US dyno and 389ms to
  Railway Singapore; input delay floor 40 ticks down to 16, so two seconds
  becomes eight hundred milliseconds.
- The fourth beat is the UI honesty pass. Nine places where the interface
  claimed more than the code could back, including a chest skip that took 25
  $MEMPIRE on chain and then silently tried to take Crowns as well, and a
  "+0.00% 📈" that turned absent data into an invented green number. Removing
  claims is the same character as publishing unfixed audit findings, so it
  earns its place in the cut.
- Pipeline inherited from `videos/day-2-devlog` — overlay rendered with alpha,
  footage composited by ffmpeg, capture over CDP screencast.
