# MagicBlock in Mempire — where it is, and how honest it is

Written to be checkable. Every claim below names the file and the suite that
proves it, and the things that are *not* real are listed with the same weight as
the things that are.

Programs on devnet:

| | |
|---|---|
| `mempire` (money) | `BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP` |
| `mempire_rollup` (hot state) | `3G4GidvjQd3yQK4bqZfem8Kkmcboygze42RcjrXg5g6N` |

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

---

## VRF — verifiable randomness

**What it does here:** the chest tier is the one outcome the house picks.
Everything else in Mempire is a function of what a player staked or how they
played. A tier chosen by `Math.random()` in the browser is exactly the mechanic
people are right to distrust in a game that also holds real SOL.

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
stake in oracle fees for cosmetics. Requests therefore go to
`DEFAULT_EPHEMERAL_QUEUE` — the delegated queue — which is the only one a
transaction running on the ER can write.

**Lifecycle, as the SDK requires:** `empty → pending(nonce) → filled`, one live
request per player, callback bound to `(slot, nonce)` and idempotent rather than
erroring, permissionless timeout recovery, and commit refused while a request is
outstanding so a callback can never be sent to an account that has left the
rollup.

**The randomness is stored on the chest** so the drop stays derivable by anyone,
and `claim_chest` emits it so it survives the slot being reused.

### The card drops, too

The tier is only half a chest. Which cards come out is now derived from the
*same* 32 bytes rather than rolled separately — `app/src/lib/chestDrop.ts`.

The derivation is a pure function of three reconstructible inputs: the seed, the
eligible coin list in registry order, and which of those the player already
owned. It uses **xoshiro256\*\*** — chosen because its state is exactly 256
bits, so every byte of the oracle's output goes into it directly — with
rejection sampling for index selection, because `% pool.length` is biased and
"slightly biased" has no place in a fairness claim.

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

## What is still not real

Listed plainly, because a build that hides these is worth less than one that
names them.

| Thing | State | Where |
|---|---|---|
| **Guest wallet** | Simulated, and labelled everywhere it appears | `state/wallet.ts`, `WalletPicker`, `ChainBadge` reads `simulated` |
| **Guest chest seeds** | Generated locally with `crypto.getRandomValues` — a session with no keypair cannot reach the oracle. Still recorded and still derivable, just not attested. Marked by the **absence** of the 🎲 | `lib/chestDrop.ts` |
| **Price / liquidity oracle** | Devnet mock — `register_coin` / `set_price`, admin-written. Jupiter/Pyth replaces it on mainnet | `chain/programs/mempire/src/lib.rs` |
| **Match seed** | Matchmaker-derived (`fnv(matchId) ^ fnv(deckA) ^ fnv(deckB)`), order-independent but **server-trusted**. Not commit-reveal | `server/matchmaker.js` |
| **SOL balance in Guest mode** | Simulated, stated on the Empire screen | `screens/Empire.tsx` |
| **Session keys** | Not implemented. PRODUCT.md promises zero wallet popups mid-battle; today each ER write is a signature | — |
| **cNFT card layer** | Not implemented. Cards are PDAs, not Bubblegum cNFTs | — |
| **Mainnet** | Devnet only | — |

The lockstep hash check is what actually protects a match, not the seed: a
divergence voids it and refunds both stakes.

---

## Running the proofs

```bash
cd chain
BASE_RPC=https://api.devnet.solana.com npx tsx scripts/e2e-full-flow.ts
```

| Suite | Covers | Result |
|---|---|---|
| `e2e-devnet.ts` | mint, eligibility gate, stake, two-step unstake, fees | 17/17 |
| `e2e-rollup.ts` | ER delegation, plays, seat auth, commit, undelegate, rent | 23/23 |
| `e2e-per-vrf.ts` | permission lifecycle, queue routing, in-flight guard, oracle callback | 20/20 |
| `e2e-full-flow.ts` | the entire match + chest lifecycle in order, two funded signers, a signature per step | 27/27 |
| `server/test-pvp.mjs` | matchmaking, lockstep relay, desync referee, forfeits | 12/12 |
| `server/test-clans.mjs` | clan lifecycle | 48/48 |
| `server/test-ladder.mjs` | Elo, leagues, drift guard | 16/16 |
| `app/test-battle-anim.mjs` | VFX pool, camera shake, strike cue vs. the real engine | 10/10 |
| `cargo test -p mempire-rollup` | chest odds partition the roll exactly 62/26/9/3 | 4/4 |
| `app/test-chest-drop.mjs` | the TS tier rule matches the Rust SDK on 256 vectors; drops are reproducible and unbiased | 12/12 |

`e2e-full-flow.ts` prints every transaction signature it produced. They open in
any devnet explorer.
