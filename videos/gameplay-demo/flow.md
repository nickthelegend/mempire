# Mempire — gameplay demo recording plan

Target: **2:30–3:00**, 1080p60. Real gameplay, two live browsers, MagicBlock
shown doing actual work rather than named in a caption.

Intro and outro are HyperFrames compositions. Everything between them is
screen capture of the live devnet build. Nothing in the middle is generated.

---

## 0. Blockers — these stop the shoot, clear them first

### 0.1 The faucet is empty

`GET /api/faucet` right now:

```json
{ "available": false, "address": "5H7JK4N4ojprNtJfvkNhBVKzyqa6x66ZEUcrgFvZku9n", "balanceSol": 0.049995 }
```

The endpoint refuses to pay below `0.35 + 0.02` SOL, so the in-app **claim
starter kit** button currently returns *"the devnet faucet is empty"* on
camera. Fund this or cut the new-player beat.

### 0.2 The GitHub repo is private

`gh repo view` reports `"visibility": "PRIVATE"`. The submission form requires
public, *or* private with **@jonasXchen** invited as a collaborator. Pick one
before submitting — this is a hard gate on the form, not a nice-to-have.

---

## 1. Wallets to fund

Devnet SOL. `solana airdrop` is rate-limited to ~2 SOL per request per address;
faucet.solana.com gives larger amounts against a GitHub login.

**Done.** 5 SOL was sent to the faucet and distributed by `app/setup-demo.mjs`.

| # | Address | Holds | Role |
|---|---|---|---|
| 1 | `5H7JK4N4ojprNtJfvkNhBVKzyqa6x66ZEUcrgFvZku9n` | **2.017 SOL** | The app faucet, `available: true`. 0.35 per claim, so ~5 claims: enough for the on-camera claim, retakes, and judges who try it themselves. |
| 2 | `2cmeus9ph2SzixtHfcpActu8tvjaMVN58H95MivMDCyE` | **1.5 SOL** · 8 cards · 2,000 $MEMPIRE | Player A. |
| 3 | `GKLFeUT1cqG82iVkRsBekyZh5eCbhHSDjdvZLA1HZzxj` | **1.5 SOL** · 8 cards · 2,000 $MEMPIRE | Player B. |
| 4 | `3YUgUPu9AdJj6FCFFvzR9pJixCN7EcAnCXMJoTuYwsS5` | 4.5 SOL | Deployer, mint authority. Not on camera. |

Keys for 2 and 3 are in `app/.demo-wallets.json`, gitignored.

Stake tiers are `Pauper 0.05 · Knight 0.25 · Duke 1 · Emperor 5` SOL. **Record
at Knight (0.25).** Pauper is too small to read on screen as real money; Duke
burns 2 SOL per take.

```bash
solana airdrop 2 5H7JK4N4ojprNtJfvkNhBVKzyqa6x66ZEUcrgFvZku9n -u devnet
```

### 1.1 Pre-mint 8 cards on both player wallets — done, and it found a bug

`useChainSync` replaces the locally seeded 8-card collection with whatever the
wallet actually holds on chain, so a wallet holding one card gets a one-card
deck and `BATTLE` refuses. Both wallets were pre-minted to eight
(`chain/scripts/premint-demo.ts`), and the on-camera mint now produces a *ninth*
card rather than collapsing the deck.

Doing that surfaced a real defect. The coin registry lives on chain and keeps
growing — **86 coins registered against the 66 the client was built with** — and
`repoint()` was auto-filling decks from everything the wallet held, unfieldable
cards included. `buildDecks` resolves each deck card's mint against the bundled
`COINS` and returns null on the first miss, so a single such card permanently
killed a working deck, with an error telling the player to fix it on a tab where
that card does not render.

Both demo wallets had minted exactly one, and neither could enter the arena.

Fixed in `app/src/state/useChainSync.ts` and deployed: staleness now means
*exists **and** this build can field it*, and auto-fill only ever chooses usable
cards. `premint-demo.ts` and `check-demo-decks.ts` restrict themselves to the
client registry for the same reason.

This affects real players, not just the shoot: anyone minting from a coin
registered after the last client build hit the same dead end.

---

## 2. Rig

Superseded the original plan (two Phantom profiles, one desktop screen grab)
for two reasons found while building it.

**No screen recording.** `ffmpeg -f avfoundation` needs macOS Screen Recording
permission, and without it it blocks forever rather than failing — nothing a
run can recover from, and granting it needs the user's password. Playwright
records the page through CDP and needs no OS permission.

**No Phantom.** `injected-wallet.mjs` plants a Phantom-shaped provider holding a
real keypair, so the app runs its ordinary adapter path and every signature that
reaches devnet is genuine. Only the extension's approval popup is skipped, which
cannot be driven anyway. Note the adapter **eagerly connects** to a provider
present before the first script — so there is no connect-and-approve moment to
film. Either skip that beat or shoot it separately on a real phone.

So:

- Two Playwright contexts, each **430×932** at `deviceScaleFactor: 2`, each
  recording its own stream, composited side by side afterwards.
- **430, not 960.** The app is a mobile-first column; at desktop widths it
  renders that column in dead space flanked by two `ADVERTISE HERE ·
  ads@mempire.fun` rails, which read as unsold inventory. Below desktop width
  those rails are not rendered at all.
- The composite is honest: both halves are the same wall-clock session recorded
  simultaneously, which is precisely why the two tick counters agree frame for
  frame.
- Headed, not headless — the arena is WebGL and headless falls back to
  SwiftShader, correct but far too slow to look like a game.
- Explorer cutaways captured separately and laid over in post.

`node record-demo.mjs --probe` is the pre-flight: it drives one client into a
real match and asserts the arena drew. Its check is a **screenshot byte count**,
not `gl.readPixels` — the context has no `preserveDrawingBuffer`, so a read from
outside the render loop returns an already-cleared buffer and reported a single
flat colour over a fully drawn arena. PNG compresses a flat colour to nothing
and a stadium to about 1.1 MB; the two cases are orders of magnitude apart.

---

## 3. Shot list

Times are cumulative. Total **2:52**.

### A · Intro — HyperFrames · 0:00–0:15

Not screen capture. Built as a HyperFrames composition.

- Wallet list, meme coins in red, dust.
- Line resolves: **"Your bags are your army."**
- Mempire mark, then `built on Solana · running on MagicBlock` with both logos.
- Hard cut into live capture — no fade. The cut from designed motion to a real
  cursor is what sells that the rest is real.

### B · The wallet is the roster · 0:15–0:35

Live, Player A.

1. Connect Phantom. Real approval popup, not a guest session.
2. Collection loads from chain — cards are the coins the wallet holds.
3. Open one card: mint address, level, power.
4. **Mint a new card** — sign, confirm, card appears.

Proves: fighters are token holdings, minting is a real transaction.

### C · Deploying troops, two clients, one simulation · 0:35–1:35

The core shot. Both browsers.

1. B taps **BATTLE** at Knight (0.25 SOL). Queue.
2. A taps **BATTLE**. Match found, both escrow 0.25 → 0.5 SOL pot on screen.
3. **Both sign the stake.** Show both popups.
4. Arena loads on both. Play ~40 seconds: deploy troops on both sides, let
   towers take damage, land at least one tower kill.
5. **Point the cursor at the tick counter and the state hash on both clients
   and let them sit side by side for three full seconds.** Identical hash, two
   machines. That single beat is the deterministic-lockstep claim, proven.

Proves: real-time PvP, real stake, deterministic sim agreeing across clients.

> Do not narrate over this. Let the game audio and the two matching hashes
> carry it.

### D · MagicBlock, doing the work · 1:35–2:10

Cutaway to Explorer while the match is still running.

1. `delegate_log` — the match log handed to the ephemeral rollup:
   `45ApLVXKM3a9P5ADX8cUSB71AByPgf9XrW5QA66hHveiavvXfdxv962SBVeaYJECcyAeZe9Ep1aQnY5AGx7dwTav`
2. Back to the game. Every tap during the match writes to the ER, not devnet —
   show the ER round-trip latency in the HUD next to a devnet confirmation for
   contrast.
3. Match ends. `end_log` commits and undelegates; settlement lands on devnet:
   `mcGNC94zgGspSMkwkrnRegLxutPs7cEPcjcnRAB9FSNLd9x64fuqpS8dmoHn6wg9qdajDzN2S5TqbqLMKHuzNiV`
   (`Instruction: ProcessUndelegation`)
4. Winner's balance goes up by the pot, on screen.

Proves: delegation → play on the rollup → commit and settle on Solana. The full
ER lifecycle, not a logo.

### E · Chest, bought with $MEMPIRE, opened by VRF · 2:10–2:40

1. Shop. Buy a treasure chest — priced in **$MEMPIRE**, not SOL. Confirmation
   modal shows the cost and the balance. Sign.
2. Chest goes on the timer.
3. Open it. The roll is **not** client-side: `delegate_chests` puts the chest
   rail on the rollup, VRF fulfills against queue
   `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc`, and `#[vrf_callback]`
   consumes the randomness on the ER.
4. Cards drop.
5. Cutaway: `delegate_chests` on devnet —
   `46gctQi5VbMA6Tgr9EgxZfUkVJtYeMZbnJxTqqrooNvVvrCWwdgyncXBUCjXJ2XZKAQHz5xT6puBTRpiaSN6uDJg`

**Honest note for the voiceover and the form:** the VRF *callback itself*
executes on the ephemeral rollup, so it does not appear in devnet Explorer. The
devnet-visible half is `delegate_chests` and the commit back. Say that plainly
rather than implying the callback is on the base-layer link — a MagicBlock judge
will know, and being straight about it reads as competence.

### F · Outro — HyperFrames · 2:40–2:52

- Three program IDs on screen, monospace, held long enough to read.
- `app.mempire.fun` · `mempire.fun/download`
- Solana + MagicBlock logos.
- Devnet disclaimer in small type. It goes here, once, honestly.

---

## 4. Rehearse these before rolling

Each one has bitten this build before.

| Risk | Guard | State |
|---|---|---|
| Deck collapses → BATTLE refuses | Pre-mint 8 fieldable cards (§1.1) | done, fix deployed |
| Wallet below the stake | Both wallets 1.5 SOL against a 0.25 stake | done |
| Faucet empty on camera | 2.017 SOL, `available: true` | done |
| Arena does not render under Playwright | `record-demo.mjs --probe` — 1.12 MB drawn on production | done |
| Matchmaker pairs A with the **bot** instead of B | B must be queued *before* A; solo wait is 20s before bot fallback | untested |
| ER slow to come up, match starts without delegation | `https://devnet-as.magicblock.app/` returns `{"result":"ok"}` before each take | reachable |
| **Public devnet RPC rate-limits mid-take** | Point `VITE_RPC_URL` at a Helius/QuickNode devnet key | **open — has 429'd twice already** |
| `/api/player/<addr>` returns 401 | Cosmetic so far: name stays ANON_KING. Confirm it does not block matchmaking before the PvP take. | open |

Do one full dry run end to end, unrecorded. The two-browser matchmaking beat is
the one that will need retakes.

---

## 5. Submission form — filled

**Project name**
```
Mempire
```

**Description — what it does and how it uses MagicBlock**
```
Mempire is a real-time 3D card battler on Solana where your fighters are the
meme coins you actually hold. Mint a card from any token in your wallet, stake
into it for power, and duel another player for a SOL pot in a Clash-Royale-style
arena.

Both clients run the same deterministic fixed-point simulation at 20 ticks per
second and hash their state every 40 ticks, so a desync is detectable rather
than arguable.

MagicBlock is what makes that playable on chain. The match log is delegated to
an ephemeral rollup (delegate_log) and every input during the match is written
there, not to devnet — base-layer confirmation times are far too slow for a
real-time arena. The log sits behind a Permissioned Ephemeral Rollup whose only
members are the two seats, so nobody else can write to a match in progress. At
the end, end_log commits and undelegates, and the result settles on Solana where
the escrow pays out.

Chest rewards use MagicBlock VRF: the chest rail is delegated (delegate_chests)
and a #[vrf_callback] consumes verifiable randomness on the rollup, so drops are
not rolled on the client. Session keys let a player field troops through a whole
match without a wallet popup per tap.
```

**Categories** → `Games` · `Consumer` · `DeFi`

**Project website** → `https://mempire.fun`

**GitHub** → `https://github.com/nickthelegend/mempire`
→ **currently PRIVATE.** Make public or invite @jonasXchen.

**Pitch & Demo** → the recorded video, uploaded (YouTube unlisted is fine)

**Explorer link (integration proof)**
```
https://explorer.solana.com/tx/45ApLVXKM3a9P5ADX8cUSB71AByPgf9XrW5QA66hHveiavvXfdxv962SBVeaYJECcyAeZe9Ep1aQnY5AGx7dwTav?cluster=devnet
```
`delegate_log` — a match log delegated to a MagicBlock ephemeral rollup.
Settlement side, if a second link is allowed:
```
https://explorer.solana.com/tx/mcGNC94zgGspSMkwkrnRegLxutPs7cEPcjcnRAB9FSNLd9x64fuqpS8dmoHn6wg9qdajDzN2S5TqbqLMKHuzNiV?cluster=devnet
```

**Program addresses**
```
mempire         BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP
mempire_rollup  3G4GidvjQd3yQK4bqZfem8Kkmcboygze42RcjrXg5g6N
mempire_amm     7tM95L7TooveTGAtmo6nRyJRQpSVADN3DPaagJmSp8CP
```

Supporting, if there's room:
```
$MEMPIRE mint   AhF5trvRTrqRU3gdDGQKCX5H5zZh5WjSw4bmeCwYFpR8
AMM pool        EHrgXgNjYCtLdWYzGwbgCup5ryy2KJhLhBoFbrdHS29w
VRF queue       5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc
```

---

## 6. Post

1. Assemble in HyperFrames: intro → capture → outro, one timeline.
2. Explorer cutaways as picture-in-picture over the live capture, so the game
   never stops moving.
3. Captions only on the claims that need proving — the state-hash match, the
   delegation, the VRF. No lower-thirds anywhere else.
4. Music bed well under the game audio. The tower-explosion and chest-open
   sounds are the best audio in the piece.
5. Export 1080p60 H.264, plus a 720p web cut.

---

## 7. Open questions for you

1. **Voiceover or captions only?** Captions are faster and there's no recording
   risk. VO is warmer and a solo-founder voice tends to land well with judges.
2. **Show the Android app?** ~15s of the APK running on a real phone with
   Mobile Wallet Adapter. Strong for the NoahAI mobile track, adds nothing for
   MagicBlock. It would push the runtime past 3:00.
3. **Show the AMM / $MEMPIRE swap?** Currently out. It supports the "DeFi"
   category but dilutes a demo whose spine is the match.
