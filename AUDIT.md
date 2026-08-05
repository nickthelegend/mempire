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

## Open — chain, value at risk

These are why the on-chain match flow must not be presented as trustless yet.

| # | Where | Severity | Defect |
|---|---|---|---|
| C1 | `mempire/src/lib.rs:608` `end_match_log` | **CRITICAL** | Accepts an arbitrary `winner` from a *single* player signer, and `settle_from_log` pays it verbatim. First player to call takes the pot without a card being played. |
| C2 | `mempire/src/lib.rs:453` `claim_timeout` | **CRITICAL** | `winner_account` need only be one of the two players, never the claimer. A loser refuses to sign `settle`, waits out the timeout, and takes the pot. |
| C3 | `mempire-amm/src/lib.rs:348` `delegate_pool` | **CRITICAL** | Permissionless, with a caller-supplied validator. An attacker delegates the pool to a validator they run and commits forged reserves — or simply freezes all LP funds. |
| C4 | `mempire-rollup/src/lib.rs:172` `delegate_log` | **CRITICAL** | Same shape: permissionless with a caller-chosen validator. |
| C5 | `mempire/src/lib.rs:527` `delegate_match_log` | **HIGH** | No signer authorisation; re-delegating a settled log forces the match down the timeout path into C2. |
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
| A1 | `state/match.ts:286` | **CRITICAL** | `openOnchainMatch` escrows real lamports at queue time; `settleTx`, `joinMatchTx` and `claimTimeoutTx` are never called anywhere in the app. Every on-chain match strands its escrow permanently. |
| A2 | `state/wallet.ts:26` | **CRITICAL** | The stake and payout shown to the player are a local zustand number seeded to 12.4, unrelated to the escrow in A1. The SOL the UI reports moving is simulated. |
| A3 | `state/match.ts:620` | **CRITICAL** | The relayed opponent deck is cast from JSON with only a length check. An `archetype ≥ 6` makes elixir cost `NaN`, so every card is free — on **both** clients, hashing identically, so no desync is ever detected. |
| A4 | `state/match.ts:359` | **HIGH** | A relay outage delivers `onSocketLost` to both clients and each settles itself the loser. Neither is paid. |
| A5 | `state/match.ts:549` | **HIGH** | Tick target derives from unsynchronised `Date.now()` with 400ms of slack; ordinary clock skew voids a staked match. |
| A6 | `state/match.ts:730` | **HIGH** | A draw (`winner === -2`) is committed to the log as `winner: 1`. Both clients write contradictory results. |
| A7 | `sim/engine.ts:467` | **MEDIUM** | `hashState` omits `phase`, targets, `level`, `trait` and `maxHp`, so a split timeline can run 40 ticks before a checkpoint notices. |

## Clean — verified, not assumed

- **Sim determinism.** No float arithmetic, `Math.random`, `Date.now`, or Set/Map iteration reaches sim state. Targeting tie-breaks are a genuine total order (distance, then lowest id), independent of array order.
- **AMM maths.** `k` never decreases; every division floors toward the pool; all intermediates are u128 with checked ops. `MINIMUM_LIQUIDITY` is added to supply without being minted, so it is genuinely unwithdrawable — the donation attack is not possible because reserves are internal state and never read from vault balances.
- **VRF.** The callback is gated on `scoped_vrf_identity`, so only the VRF program can deliver. Replays and cancelled-request callbacks are rejected by a `(slot, nonce, state)` re-check. The player's `caller_seed` picks among 256 inputs to an oracle they cannot evaluate — no grinding path.
- **Rake arithmetic.** `rake + payout == pot` exactly in all three payout paths. No double-settlement; all paths require `Active` and set `Settled`.
- **Unstaking.** `has_one = owner` plus a PDA-authority vault; no cross-player unstake, and the 72h two-step cannot be replayed.
- **NoSQL injection, ReDoS, committed secrets, Dockerfile.** All clean — Express 5's `simple` query parser yields only strings, regex metacharacters are escaped, `.env` is untracked in both git and Docker, and the image runs non-root with a healthcheck.
