---
workflow: general-video
flow: automation
storyboard: no
message: "Day 2: the game looks and plays like a game, and the chain half is real but unfinished"
destination: x-feed
aspect: 1080x1920
language: en
length: 10s
angle: devlog
---

## Intent

A day-two build-in-public post for the Solana Blitz V7 / MagicBlock hackathon.
One slide, no narration, ~10 seconds, vertical for X.

The whole point is that the game **runs**. Every other launch post in this
category is a mockup, so the footage is not decoration here — it is the claim.
It plays full-bleed for the entire ten seconds and the copy arrives on top of
it, so a viewer sees the thing working before they read a word about it.

The message is deliberately split and honest: the design half is done, the
chain half is real but partial. A devlog that claims everything is finished on
day two is a devlog nobody believes.

## Assets

- `assets/gameplay.mp4` — 10s of a real practice match, captured headlessly from
  the running dev build. The hero; plays full-bleed for the whole composition.
- `assets/logo.png` — the MEMPIRE wordmark, the only place the name is set.
- `assets/fonts/lilita-one.woff2` — the game's own display face, taken from the
  app's `@fontsource` dependency and embedded via `@font-face`. Lilita One is
  not one of the renderer's pre-bundled families, so the implicit Google fetch
  would lint-warn and is fail-closed in a cloud render.
- `assets/card_sol.png` — the $SOL fighter, transparent. Unused in the current
  cut; kept staged in case the close wants a character.

## Notes

- **The composition is an overlay, not the whole frame.** `index.html` renders
  to a MOV with alpha; `node build.mjs` composites it over `assets/gameplay.mp4`
  with ffmpeg. A `<video>` inside the composition was tried first and abandoned:
  the producer swaps each timed video for a pre-extracted frame, and ~1 frame in
  7 came back drawn at 40% scale in the top-left. It passed `check`, passed
  `lint`, and reported a successful render, because `--best-effort` defaults to
  true and downgrades unready media to a warning.
- The footage itself also had to be re-captured twice. Playwright's
  `recordVideo` fits the page into a fixed video size and mangles frames
  whenever layout settles — the same corner-scaled artefact, baked into the
  source. `Page.startScreencast` over CDP was clean. And the first screencast
  ran at 4fps because the launch flags forced SwiftShader; on the real GPU it
  holds ~68fps.

- Claims must stay true. Design, 64 fighters, the arena and the UI are done;
  ER, PER and VRF are live on **devnet**; mainnet is not. The word "devnet"
  stays on screen next to the chain line.
- The look is not invented: it is Mempire's own Royale Arcade system, the same
  tokens as `app/src/styles/tokens.css` — violet hall, royal-blue quilt, carved
  wood, ink outlines, and gold reserved for money and the URL only.
- The footage was captured with a headless browser on purpose. A browser halts
  `requestAnimationFrame` while its document is hidden, so screenshots taken
  from a background pane came back as an empty navy rectangle with the HUD
  floating on it — the arena had never drawn a frame.
