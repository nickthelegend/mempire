---
workflow: general-video
flow: automation
storyboard: no
message: "We audited our own game, closed six criticals, and published the findings we have not fixed"
destination: x-feed
aspect: 1080x1920
language: en
length: 12s
angle: devlog
---

## Intent

Day three of building in public for Solana Blitz V7. One slide, no narration,
12 seconds, vertical for X.

Day two said "it looks like a game now". This one is the opposite register:
the game is the same, and the day went into trying to break it. Five parallel
audits found pot theft, permissionless delegation and stranded escrow, all of
which are now closed and proved closed against devnet.

The close is the point of the whole post: **nine open findings, published**.
Anyone can claim an audit. Publishing the list of what is still wrong — with
severity and exploit path — is the part nobody fakes, and it is what makes the
fixed column believable.

## Assets

- `assets/tour.mp4` — 12s of a real practice match, captured from the audited
  build after the redeploy. The bed, not the subject: the audit is the message
  and the game is the evidence it protects something.
- `assets/logo.png` — the wordmark.
- `assets/fonts/lilita-one.woff2` — the game's own display face, embedded.

## Notes

- Every number is from `AUDIT.md` and verified against the deployed programs:
  five audits, six CRITICALs in the fixed column (S1, C1, C2, C3, C4, A1, A3 —
  six of them rated CRITICAL), `e2e-security` 8/8, nine findings still open.
  Nothing here is rounded up.
- The overlay/composite split and the capture technique are inherited from
  `videos/day-2-devlog` — its BRIEF explains why a `<video>` inside the
  composition and Playwright's `recordVideo` were both abandoned.
- Footage is re-shot rather than reused from day two, because the build
  changed underneath it: the audit fixes, the Crowns/$MEMPIRE split, and the
  duplicate card-art fetch are all in this capture.
