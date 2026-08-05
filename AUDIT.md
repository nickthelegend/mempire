# Audit — 4 Aug 2026

Five parallel audits of the whole repo. Findings are recorded here **whether or
not they are fixed**, because a known unfixed defect that nobody wrote down is
indistinguishable from one nobody found.

Severity is by what an attacker gains, not by how hard it was to spot.

## Fixed

| # | Where | Was |
|---|---|---|
| S1 | `server/*` | **CRITICAL** No auth of any kind. Every route identified its caller by a wallet address in the URL — an address the API itself publishes via `/api/ladder` and `/api/clans/:tag`. Anyone could set any player's Elo, grant themselves crowns, or kick a whole clan roster. Now every mutating route requires an ed25519 signature over a timestamped, per-action message. |
| S2 | `server/index.js` | **HIGH** Rate limiter keyed on `req.ip` with `trust proxy` off, so behind Railway's edge every player shared one bucket and six writes/sec from one client 429'd everybody. |
| C1 | `mempire` `end_match_log` | **CRITICAL** A single signer set the winner and `settle_from_log` paid it — first to call took the pot without playing. Now each seat records a claim and settlement requires agreement; disagreement voids. |
| C2 | `mempire` `claim_timeout` | **CRITICAL** A loser could stall past the deadline and claim the pot. Now only pays the claimer, and the third-party grace path is gone. |
| C3 | `mempire-amm` `delegate_pool` | **CRITICAL** Permissionless with a caller-chosen validator. Removed with `commit_pool` — a rollup buys an AMM nothing. |
| C4/C5 | `delegate_log`, `delegate_match_log` | **CRITICAL/HIGH** Permissionless. Both now require the payer to be a player. Proved by `e2e-security.ts`. |
| A1 | `state/match.ts` | **CRITICAL** Escrowed lamports nothing could settle, refund or time out. Removed until the settle path exists. |
| A3 | `state/match.ts` | **CRITICAL** Relayed opponent deck was unvalidated; an out-of-range archetype made every card free on both clients, hashing identically so no desync fired. |
| A4 | `state/match.ts` | **HIGH** A relay outage settled BOTH clients as the loser. Now voids. |
| A6 | `state/match.ts` | **HIGH** A draw was committed as "seat 1 won". |
| A7 | `sim/engine.ts` | **MEDIUM** The state hash omitted phase, targets, level, trait and maxHp. |
| E1 | `lib/audio.ts`, `components/CardFrame.tsx` | **LOW** Every sound and every card image was fetched 2–3 times and the duplicates cancelled — 48 aborted requests a session on mobile, now zero. |

## Open — chain

Real, and none of them is pot theft. Recorded with severity and exploit path
so the next person does not have to re-derive them.

| # | Where | Severity | Defect |
|---|---|---|---|
| C6 | `mempire/src/lib.rs:732` `unlock_deck` | **HIGH** | Clears `in_match` on any account that deserialises as a `Card`, with no check it belongs to this match. Frees a locked deck, bypassing the power bracket. |
| C7 | `mempire-rollup/src/lib.rs:279` `unseal_log` | **HIGH** | No seat check and no `!ended` check — any third party can unseal a live match, exposing plays before they resolve. |
| C8 | `mempire-rollup/src/lib.rs:319` `open_session` | **HIGH** | Accepts a session key equal to the *other* seat's key; `seat_for` then attributes the victim's plays to the attacker's seat and voids the match on demand. |
| C9 | `mempire-rollup/src/lib.rs:539` `request_chest` | **HIGH** | Nothing consumes an earned chest. Loop request → claim to farm unlimited chests; the one-per-match rule exists only in the client. |
| C10 | `mempire/src/lib.rs:995` `ClaimUnstake` | **MEDIUM** | `treasury_tokens` constrained on `.mint` only, never tied to `config.treasury`. The unstaker passes their own account and refunds their own fee. |
| C11 | `mempire/src/lib.rs:293` `create_match` | **MEDIUM** | No cancel path for an `Open` match: an unjoined match strands the stake and locks 8 cards forever. |
| C12 | `mempire/src/lib.rs:60` `init_config` | **MEDIUM** | Not bound to the upgrade authority. Whoever front-runs the first call owns rake, fees and prices permanently. |

## Open — client

| # | Where | Severity | Defect |
|---|---|---|---|
| A2 | `state/wallet.ts:26` | **KNOWN** | The stake and payout shown are a local number, not chain state. This is now what the game claims: the SOL tier is presentation, and the escrow that used to back it (A1) is removed because nothing could settle it. Wiring join/settle/timeout end-to-end is the work that makes the stake real. |
| A5 | `state/match.ts:549` | **HIGH** | Tick target derives from unsynchronised `Date.now()` with 400ms of slack; ordinary clock skew voids a staked match. |

## Clean — verified, not assumed

- **Sim determinism.** No float arithmetic, `Math.random`, `Date.now`, or Set/Map iteration reaches sim state. Targeting tie-breaks are a genuine total order (distance, then lowest id), independent of array order.
- **AMM maths.** `k` never decreases; every division floors toward the pool; all intermediates are u128 with checked ops. `MINIMUM_LIQUIDITY` is added to supply without being minted, so it is genuinely unwithdrawable — the donation attack is not possible because reserves are internal state and never read from vault balances.
- **VRF.** The callback is gated on `scoped_vrf_identity`, so only the VRF program can deliver. Replays and cancelled-request callbacks are rejected by a `(slot, nonce, state)` re-check. The player's `caller_seed` picks among 256 inputs to an oracle they cannot evaluate — no grinding path.
- **Rake arithmetic.** `rake + payout == pot` exactly in all three payout paths. No double-settlement; all paths require `Active` and set `Settled`.
- **Unstaking.** `has_one = owner` plus a PDA-authority vault; no cross-player unstake, and the 72h two-step cannot be replayed.
- **NoSQL injection, ReDoS, committed secrets, Dockerfile.** All clean — Express 5's `simple` query parser yields only strings, regex metacharacters are escaped, `.env` is untracked in both git and Docker, and the image runs non-root with a healthcheck.

## Verified against the deployed programs — 5 Aug

| Suite | |
|---|---|
| `e2e-amm` | 18/18 · real USDC, real curve |
| `e2e-per-vrf` | 21/21 · delegation, seal, oracle callback |
| `e2e-full-flow` | 32/32 · 16 real transactions |
| `e2e-security` | 8/8 · the exploits, refused |
| AMM unit tests | 14/14 |
| Client suites | 34/34 |
| Live E2E, both sites, mobile + desktop | 90/92 |

The two E2E failures are the same check on two viewports: the Clan tab shows an
offline placeholder because the API is not deployed. Ranked and the leaderboard
are dark for the same reason.
