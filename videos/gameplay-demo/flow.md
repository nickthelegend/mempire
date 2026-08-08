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

| # | Address | Fund to | Why |
|---|---|---|---|
| 1 | `5H7JK4N4ojprNtJfvkNhBVKzyqa6x66ZEUcrgFvZku9n` | **3 SOL** | The app faucet. 0.35 per claim; 3 SOL covers the on-camera claim plus retakes and leaves the demo working for judges who try it themselves. |
| 2 | Player A — your Phantom, devnet | **2 SOL** | Stake + mint fees + gas. |
| 3 | Player B — a second Phantom profile, devnet | **2 SOL** | Same. Must be a different browser profile, not a second tab. |
| 4 | `3YUgUPu9AdJj6FCFFvzR9pJixCN7EcAnCXMJoTuYwsS5` | already 4.535 SOL — leave it | Deployer / upgrade authority. Not used on camera. |

Stake tiers are `Pauper 0.05 · Knight 0.25 · Duke 1 · Emperor 5` SOL. **Record
at Knight (0.25).** Pauper is too small to read on screen as real money; Duke
burns 2 SOL per take.

```bash
solana airdrop 2 5H7JK4N4ojprNtJfvkNhBVKzyqa6x66ZEUcrgFvZku9n -u devnet
```

### 1.1 Pre-mint 8 cards on both player wallets — do not skip this

`useChainSync` replaces the locally seeded 8-card collection with whatever the
wallet actually holds on chain. A wallet that has minted **one** card ends up
with a one-card collection, the deck is re-pointed to that one card, and
`BATTLE` refuses with *"deck needs 8 cards"*.

So a fresh wallet that mints a single card on camera **breaks the very next
shot**. Both player wallets must hold 8+ minted cards before recording. Then
the mint beat on camera mints a *ninth* card, the collection grows, and nothing
collapses.

---

## 2. Rig

- Two Chrome profiles side by side, each **960×1080**, Phantom set to devnet in
  both. Profile A left, profile B right.
- Record the **full 1920×1080 desktop** as one take, so both clients are in the
  same frame and the sync between them is self-evident. Split-screen faked in
  post is exactly what a judge will suspect.
- A third profile in the background holding Solana Explorer, brought up as a
  cutaway rather than recorded live.
- Hide bookmarks, mute notifications, `play.mempire.fun` in both.
- QuickTime or OBS. If OBS: 60 fps, CQP 18, capture the display not the window.

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

| Risk | Guard |
|---|---|
| Fresh wallet mints 1 card → deck collapses to 1 → BATTLE refuses | Pre-mint 8 on both wallets (§1.1) |
| Wallet below the stake → *"need 0.25 SOL to enter"* | Both wallets ≥ 2 SOL |
| Faucet returns empty on camera | Fund §1.1 first |
| Matchmaker pairs A with the **bot** instead of B | B must be queued *before* A; solo wait is 20s before bot fallback |
| ER slow to come up, match starts without delegation | Check `https://devnet-as.magicblock.app/` returns `{"result":"ok"}` before each take |
| Public devnet RPC rate-limits mid-take | Point `VITE_RPC_URL` at a Helius devnet key for the shoot |

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
