# MagicBlock in Mempire — where it is, and how honest it is

Written to be checkable. Every claim below names the file and the suite that
proves it, and the things that are *not* real are listed with the same weight as
the things that are.

Programs on devnet:

| | |
|---|---|
| `mempire` (money) | `BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP` |
| `mempire_rollup` (hot state) | `3G4GidvjQd3yQK4bqZfem8Kkmcboygze42RcjrXg5g6N` |

**Which build this describes.** Devnet runs the full build, so everything below
is live there. Mainnet starts smaller, and exactly *how* much smaller is the one
budget decision in this document.

`nft` and `rollup` are cargo features — on by default, switched off with
`--no-default-features`. Measured from this repo's own builds:

| Build | Bytes | Deploy rent |
|---|---|---|
| `mainnet` (lean) | 469,736 | 3.27 SOL |
| `mainnet,rollup` | 599,040 | 4.17 SOL |
| `mainnet,nft,rollup` | 710,304 | 4.94 SOL |
| `mempire_rollup` (its own program) | 441,432 | 3.07 SOL |

That rent is a refundable deposit, not a spend; `solana program close` returns
it. **The launch target is `mainnet,rollup` at 4.17** — the lean build strips
MagicBlock out entirely, and the 0.90 SOL between them is the difference between
an integration that is live on mainnet and one that is only live on devnet.
`mempire_rollup` — the play log, the seal, the chest rolls — is a further 3.07
and waits for v3.

What the rollup build costs is stated in each section below. What no build
costs is settlement. `end_match_log` compiles in both with the same accounts bar
the two magic ones, `claimResultEr` writes a seat's claim wherever the log
actually is, and `settle_from_log` reads both claims off the base-layer account
either way. A match escrows, settles and times out identically with or without a
rollup — which is what makes the rollup deferrable, and also what makes deferring
it a presentation decision rather than a functional one.

---

## ER — Ephemeral Rollups

**What it does here:** the match input log lives on a rollup for the duration of
a match, so card plays are genuinely onchain rather than relayed by a server we
happen to operate.

| Layer | Where |
|---|---|
| Program | `chain/programs/mempire-rollup/src/lib.rs` — `#[ephemeral]`, `#[delegate]`, `#[commit]`, `MagicIntentBundleBuilder` |
| Instructions | `init_log`, `delegate_log` (base) · `play_card`, `checkpoint`, `end_log` (ER) · `close_log` (base) |
| Client | `app/src/chain/erActions.ts`, driven by `app/src/state/erMatch.ts` |
| Router | `app/src/chain/magicblock.ts` — ER endpoint discovered per account via `getDelegationStatus`, never hardcoded |

**Wired to the game:** yes. `state/match.ts` calls `useErMatch.play()` on every
card drop.

**Deliberate design:** the rollup program has **no transfer path**. It owns no
lamports beyond its own rent. Escrow and payout stay in `mempire` on base layer,
so a stalled rollup costs latency and degrades to `claim_timeout` — it can never
strand a pot.

**Without it (v1 and v2, which do not deploy `mempire_rollup`):** no per-play
log exists, because there is no `mempire_rollup` to write one. The match still
runs the same deterministic lockstep sim and the server still referees a
desync; the plays are simply
relayed rather than recorded on chain, which is exactly the property this
section exists to buy back later.

---

## PER — Private Ephemeral Rollups

**What it does here:** the sim runs two ticks behind the input a player submits,
which is what hides network latency. That delay is only safe while nobody can
read the log faster than the sim consumes it — otherwise an observer polling the
rollup sees the opponent's card and placement *before* it resolves on screen. On
a match with real SOL on it, that is a cheat.

| Layer | Where |
|---|---|
| Program | `chain/programs/mempire-rollup/src/lib.rs` — `seal_log`, `reseal_log`, `unseal_log` |
| SDK | `access-control` feature; `Create`/`Update`/`CloseEphemeralPermissionCpi` |
| Client | `sealLogEr` / `unsealLogEr` in `erActions.ts`, called from `erMatch.begin()` and `erMatch.finish()` |
| UI | `components/RollupBadge.tsx` — padlock **only** when the seal actually took |

**Wired to the game:** yes, as of the current build. It was not before — the
instructions existed and were verified onchain while every real match ran
unsealed.

**Model, followed exactly:** only the data PDA is delegated on base. The
permission is created, updated and closed entirely on the rollup. There is **no
base-layer permission account** — the suite asserts its absence, not just the
ER copy's presence.

**Two things worth knowing:**

- The log pre-funds its own permission rent at `init_log`, because a PDA cannot
  be topped up from inside a rollup. Getting that wrong surfaces as a failed
  seal *after* the match is paid for.
- `unseal_log` is deliberately **not** part of `end_log`. Folding it in as
  Anchor `Option` accounts broke every existing caller, settlement included:
  Anchor substitutes the program id for an omitted optional, and they were
  `mut`. Settlement must never gain a new way to fail, so `end_log` keeps the
  four accounts it always had and does not depend on the permission at all.

**Without it (v1 and v2):** there is no sealed log because there is no log —
the relay carries the plays, and the relay is a party both players have to
trust. That is precisely the trust this section exists to delete, which is why
the rollup is deferred rather than dropped.

---

## VRF — verifiable randomness

**What it does here:** the chest tier is the one outcome the house picks.
Everything else in Mempire follows from how a match was played. That makes the
tier load-bearing rather than decorative: a win earns a chest, a chest drops
cards, and a duplicate card merged into the one you keep is how a card climbs
from level 1 to 10. The chest rail *is* the progression system. A tier chosen by
`Math.random()` in the browser is exactly the mechanic people are right to
distrust in a game that also escrows real SOL.

| Layer | Where |
|---|---|
| Program | `chain/programs/mempire-rollup/src/lib.rs` — `request_chest` (`#[vrf]`), `callback_chest` (`#[vrf_callback]`), `claim_chest`, `cancel_chest` |
| Odds | `chain/programs/mempire-rollup/src/chests.rs` — 62/26/9/3, unit-tested against the published table |
| Client | `requestChestEr` / `readChestRail` / `claimChestEr` in `erActions.ts`, called from `state/match.ts` |
| UI | `components/Chests.tsx` — 🎲 **only** on a chest the oracle actually rolled |

**Wired to the game:** yes, as of the current build. Before that, chests were
`Math.random()` while the README claimed otherwise.

**Why on the rollup:** MagicBlock prices ER randomness at **zero** and
base-layer randomness at **0.0008 SOL** per request
([pricing](https://docs.magicblock.gg/pages/overview/additional-information/pricing#vrf)).
A player opening four chests a session should not pay a fraction of a Pauper
wager in oracle fees to collect what they won by winning. Requests therefore go
to `DEFAULT_EPHEMERAL_QUEUE` — the delegated queue — which is the only one a
transaction running on the ER can write.

**Lifecycle, as the SDK requires:** `empty → pending(nonce) → filled`, one live
request per player, callback bound to `(slot, nonce)` and idempotent rather than
erroring, permissionless timeout recovery, and commit refused while a request is
outstanding so a callback can never be sent to an account that has left the
rollup.

**Without it (v1 and v2):** every chest takes the local-seed path below —
seeded with `crypto.getRandomValues`, recorded, and derivable by anyone holding
the seed, but attested by nobody. The UI marks that by withholding the 🎲. The
odds are the same numbers; what is missing is the proof they were rolled fairly,
and that is the honest reason to add the rollup before the pots get large.

**The randomness is stored on the chest** so the drop stays derivable by anyone,
and `claim_chest` emits it so it survives the slot being reused.

### The card drops, too

The tier is only half a chest. Which cards come out is now derived from the
*same* 32 bytes rather than rolled separately — `app/src/lib/chestDrop.ts`.

The derivation is a pure function of three reconstructible inputs: the seed, the
eligible asset list in registry order — the cluster's roster, 66 seeded mints on
devnet and 36 verified assets on mainnet, majors and memecoins and tokenised
stocks alike, filtered by the published liquidity and age gate — and which of
those the player already owned. It uses **xoshiro256\*\*** — chosen because its
state is exactly 256 bits, so every byte of the oracle's output goes into it
directly — with rejection sampling for index selection, because `% pool.length`
is biased and "slightly biased" has no place in a fairness claim.

`owned` shapes the draw and is part of the published rule: unowned assets come
out first and without replacement, so a drop teaches a new card before it repeats
one. Duplicates appear once that pool is exhausted, and a duplicate is not a
wasted drop — merging it into the card it duplicates is what raises that card's
level. This is the only path from level 1 to level 10 in the game.

The tier rule is mirrored from the program byte-for-byte, including the SDK's
reverse-scan bias avoidance. That buys two things: a locally-seeded chest has the
**published odds** rather than merely similar ones, and the client can **verify
the oracle** — `reconcileNewestChest` re-derives the tier from the bytes the
program wrote and refuses the update if they disagree, rather than trusting a
number that does not follow from its own seed.

Every chest carries a seed from birth, so `Math.random()` is gone from the reward
path entirely. A Guest chest is seeded locally — still recorded, still derivable,
just not oracle-attested — and the UI marks the difference: 🎲 for VRF, nothing
for local, with the seed shown on the reward screen either way.

Proven, not asserted:

```
$ npx tsx app/test-chest-drop.mjs
  (256/256 vectors identical to the on-chain implementation)
  (64/64 distinct coins across 400 first-draws)
12 passed, 0 failed
```

That first line runs the **real Rust SDK** through `cargo` and compares outputs,
so a divergence between the client's odds and the chain's fails the suite instead
of shipping.

---

## Session keys — no wallet popups mid-battle

`chain/programs/mempire-rollup` — `open_session`, `close_session` · client
`app/src/chain/session.ts`

A three-minute match writes a card play per drop and a checkpoint every forty
ticks. Signed by the connected wallet that is dozens of Phantom prompts, which
does not make the game annoying so much as unplayable. The seat authorises a
temporary keypair once and the rollup accepts it for the rest of the match.

**Not the `session-keys` crate.** It pins Anchor 1.x and these programs are
0.32.1 — adding it pulls in a second copy of `anchor-lang`, and there is no
`anchor-compat` escape hatch like the ER SDK has. The session lives on the match
log instead: two signer slots and two expiries, one per seat.

That turned out to be the better design anyway. The log is already delegated, so
the session is readable exactly where `play_card` runs — a separate session
account would have to be delegated to the same validator, and getting that wrong
fails mid-match. And a session stored on the log is scoped to **one match** by
construction; there is nowhere for it to be replayed.

**Why handing the key out is safe.** This program has no transfer path. It owns
no lamports beyond its own rent and cannot move a token. The worst a stolen
session key does is write nonsense into one match log — and the lockstep hash
check already voids a match whose log disagrees with the simulation, refunding
both wagers. Escrow and payout live in the base-layer program and stay
wallet-only, deliberately. Nor is there anything else of the player's to reach:
the game holds no token vaults and never has custody of a holding, only the SOL
a player chose to put on this one match.

`play_card` and `checkpoint` keep the account list they always had. Widening
authority is a change to who may sign, not to what must be passed, so every
existing caller kept working — the lesson from the `end_log` regression.

Enforced on-chain, not in the UI: expiry, a 30-minute ceiling, a session key
that may not be one of the seats, and revocation that only a wallet can perform
(a stolen key revoking itself would lock the owner out of their own seat).

The session key is **never funded** — rollup fees are zero, which is the other
reason a session on an ER is cheap to hand out. The suite proves an unfunded key
signs successfully.

---

## The AMM — $MEMPIRE / USDC

`chain/programs/mempire-amm` · deployed `7tM95L7TooveTGAtmo6nRyJRQpSVADN3DPaagJmSp8CP`

| | |
|---|---|
| $MEMPIRE | `AhF5trvRTrqRU3gdDGQKCX5H5zZh5WjSw4bmeCwYFpR8` — 1B supply, 6 decimals |
| Quote asset | **Circle's real USDC** `4zMMC9…ncDU` — not a mint this repo created |
| Pool | `EHrgXgNjYCtLdWYzGwbgCup5ryy2KJhLhBoFbrdHS29w` — constant product, 0.30% |
| Client | `app/src/chain/amm.ts`, `app/src/screens/Swap.tsx` |

Nothing about it is simulated. The reserves are two genuine SPL token accounts
owned by the pool PDA, a swap moves tokens with a real `token::transfer` both
ways, and LP shares are a real SPL mint whose authority is the pool.

Opened at 1.8M $MEMPIRE / 18 USDC — $0.00001 a token, a $10,000 FDV. **A live
swap of 1 USDC bought 94,467.547507 $MEMPIRE**, matching the published formula
to the unit; `k` grew and the price moved $0.00001 → $0.00001114.

The maths is integer-only with `u128` intermediates — `reserve_in * 10_000`
overflows `u64` at ~1.8e15 base units, which a six-decimal USDC pool reaches —
and division floors toward the pool everywhere, which the tests assert rather
than assume.

**Where it runs.** Base layer. `delegate_pool` and `commit_pool` exist and the
`swap` instruction is layer-agnostic by design, but a swap executed *on* a
rollup also needs the pool's two vault ATAs delegated through Ephemeral SPL
Token, and that is not implemented — so an ER swap would fail at the token CPI
today. Said plainly rather than implied by the presence of the instructions.

---

## What is still not real

Listed plainly, because a build that hides these is worth less than one that
names them.

| Thing | State | Where |
|---|---|---|
| **Guest wallet** | Simulated, and labelled everywhere it appears | `state/wallet.ts`, `WalletPicker`, `ChainBadge` reads `simulated` |
| **Guest chest seeds** | Generated locally with `crypto.getRandomValues` — a session with no keypair cannot reach the oracle. Still recorded and still derivable, just not attested. Marked by the **absence** of the 🎲 | `lib/chestDrop.ts` |
| **Price / liquidity oracle** | Admin-written — `register_coin` / `set_price`. Devnet values are a mock; mainnet's come from Jupiter's verified list plus DexScreener reads, written the same way. Feeds the mint eligibility gate and nothing else — it no longer sets a card's level, and nothing does but merging a duplicate | `chain/programs/mempire/src/lib.rs` |
| **Match seed** | Matchmaker-derived (`fnv(matchId) ^ fnv(deckA) ^ fnv(deckB)`), order-independent but **server-trusted**. Not commit-reveal | `server/matchmaker.js` |
| **SOL balance in Guest mode** | Simulated, stated on the Empire screen | `screens/Empire.tsx` |
| **cNFT card layer** | Not implemented, and not the plan any more. Cards are PDAs; `tokenize_card` mints a Metaplex 1-of-1 on top of one, in builds carrying the `nft` feature. Builds without `nft` — which includes the v2 launch build — do not compile that instruction at all | `chain/programs/mempire/src/lib.rs`, `components/CardDetail.tsx` |
| **AMM on the rollup** | The pool has delegate/commit instructions, but swaps run on base layer: the vault ATAs are not delegated through eSPL, so an ER swap would fail at the token CPI | `programs/mempire-amm` |
| **PER on the pool** | Not built. The design follows the sealed-auction split — public pool so reserves stay auditable, private per-trader orders so size cannot be front-run | — |
| **Mainnet** | Devnet only so far. At launch the split is uneven and worth stating precisely: v2 builds `mainnet,rollup`, so **ER delegation and commit of the settlement log are live** — but `mempire_rollup` is a separate program that is not deployed on day one, so the per-play log, PER sealing and VRF chests are not. Chests roll from a local seed until v3, and the UI says so by withholding the 🎲 | `MAINNET.md` |

The lockstep hash check is what actually protects a match, not the seed: a
divergence voids it and refunds both wagers.

---

## Running the proofs

```bash
cd chain
BASE_RPC=https://api.devnet.solana.com npx tsx scripts/e2e-full-flow.ts
```

| Suite | Covers | Result |
|---|---|---|
| `e2e-devnet.ts` | mint, eligibility gate, fees — and stake plus two-step unstake, which the program no longer has | 17/17, **superseded**: its staking half calls instructions that were removed, so the result is a record of the build it was written against, not a suite that runs green today |
| `e2e-rollup.ts` | ER delegation, plays, seat auth, commit, undelegate, rent | 23/23 |
| `e2e-per-vrf.ts` | permission lifecycle, queue routing, in-flight guard, oracle callback | 20/20 |
| `e2e-full-flow.ts` | the entire match + chest lifecycle in order, two funded signers, a signature per step | 27/27 |
| `server/test-pvp.mjs` | matchmaking, lockstep relay, desync referee, forfeits | 12/12 |
| `server/test-clans.mjs` | clan lifecycle | 48/48 |
| `server/test-ladder.mjs` | Elo, leagues, drift guard | 16/16 |
| `app/test-battle-anim.mjs` | VFX pool, camera shake, strike cue vs. the real engine | 10/10 |
| `cargo test -p mempire-rollup` | chest odds partition the roll exactly 62/26/9/3 | 4/4 |
| `app/test-chest-drop.mjs` | the TS tier rule matches the Rust SDK on 256 vectors; drops are reproducible and unbiased | 12/12 |
| `cargo test -p mempire-amm` | k never decreases, rounding favours the pool, no free round trip, LP accounting | 14/14 |
| `cargo test -p mempire-rollup` | chest odds, and session authority: expiry, revocation, seat attribution, the zero key | 11/11 |
| `server/test-api.mjs` | all 22 HTTP routes, the WebSocket upgrade, body cap, rate limiting | 30/30 |
| `chain/scripts/e2e-amm.ts` | real SPL tokens moving: vault ownership, conservation, formula agreement, slippage/zero/substituted-vault guards | 18/18 |

`e2e-full-flow.ts` prints every transaction signature it produced. They open in
any devnet explorer.
