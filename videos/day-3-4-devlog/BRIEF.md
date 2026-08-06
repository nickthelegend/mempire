---
workflow: general-video
flow: automation
storyboard: no
message: "We audited our own game, closed every finding, and made the stake settle on chain"
destination: x-feed
aspect: 1080x1920
language: en
length: 18s
angle: devlog
---

## Intent

Days three and four of building in public for Solana Blitz V7, in one slide.
No narration, 18 seconds, vertical for X.

The two days are a turn, and the video is built on it. Day three broke the
game — five parallel audits, pot theft, permissionless delegation, stranded
escrow. Day four closed every one of them and then went further: the stake,
which had been a local number the client drew, now escrows, requires both
seats to agree, and settles on chain.

That is why there are two headlines rather than one. A single line across both
days would flatten the only structure the piece has.

The close is the strongest claim available and it is a measured one: match #19
is `Settled` on devnet with 0.0947 SOL returned against a 0.100 pot — the tie
rake, read off the ledger rather than off the UI.

## Assets

- `assets/gameplay.mp4` — 18s of a real practice match on the current build,
  after the audit fixes and the escrow work.
- `assets/music_battle.m4a` — the game's **own** battle track, straight from
  `app/public/sfx`. A generated bed would have been one more thing to license
  and one more thing that is not the product; this is what a player hears while
  doing exactly what is on screen. Mixed at −9dB under the copy with a two
  second tail so the clip ends rather than stopping.
- `assets/logo.png`, `assets/fonts/lilita-one.woff2` — wordmark and the game's
  display face.

## Notes

- Every figure is from `AUDIT.md` as it now stands: "Open — chain: None",
  "Open — client: None", A2 closed, and match #19 at 0.0947 of 0.100. The
  two-browser run is `app/e2e-two-browsers.mjs`, 14/14 against production.
- @magicblock is tagged on the closing frame as well as in the post.
- The overlay/composite split and the capture technique are inherited from
  `videos/day-2-devlog`; its BRIEF explains why a `<video>` inside the
  composition and Playwright's `recordVideo` were both abandoned.
