# Audit — 4 Aug 2026, closed out 6 Aug

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
| C6 | `mempire` `unlock_deck` | **HIGH** Cleared the lock on any account that deserialised as a `Card`, so settling one match freed a deck out of another still-running one — the power bracket, bypassed. `in_match: bool` is now `locked_by: Pubkey` and unlocking skips anything this match does not hold. |
| C7 | `mempire-rollup` `unseal_log` | **HIGH** No seat check: a stranger could open a live match's permission and read both hands two ticks before they resolved. Now seat-only. |
| C8 | `mempire-rollup` `open_session` | **HIGH** Accepted a session key equal to a seat. Now refuses a seat key *and* the other seat's session key, so attribution never depends on iteration order. |
| C9 | `mempire-rollup` `request_chest` | **HIGH** Nothing consumed an earned chest — request → claim → request minted drops forever, with the one-per-match rule living only in the client. Wins now grant an `earned` entitlement that a roll spends. |
| C10 | `mempire` `ClaimUnstake` | **MEDIUM** `treasury_tokens` was constrained on `.mint` alone, so the unstaker passed their own account and refunded their own fee. Now tied to `config.treasury`. |
| C11 | `mempire` `create_match` | **MEDIUM** No cancel path: an unjoined match stranded the stake and locked eight cards forever. `cancel_match` refunds the creator and releases the deck. |
| C12 | `mempire` `init_config` | **MEDIUM** Whoever front-ran the first call owned rake, fees and prices permanently. Now bound to the program's upgrade authority. |
| A5 | `state/match.ts` | **HIGH** Both clients stepped `(Date.now() - startAt)` against their *own* wall clocks, so ordinary drift on a laptop that had been asleep desynced the sim and voided a staked match. The matchmaker now stamps `serverNow` and each client corrects for its offset. |
| E1 | `lib/audio.ts`, `components/CardFrame.tsx` | **LOW** Every sound and every card image was fetched 2–3 times and the duplicates cancelled — 48 aborted requests a session on mobile, now zero. |

## Open — chain

None. Every finding above is fixed, deployed to devnet, and has a test in
`e2e-security.ts` that attempts the original exploit and asserts the refusal.

Two migrations were needed and are kept for the record: `migrate-cards.ts`
(`Card` grew 31 bytes when `in_match` became `locked_by`) and
`migrate-chests.ts` (`PlayerChests` grew 2 bytes for `earned`). Both are
idempotent and owner-signed.

## Open — client

None.

**A2 is closed.** The stake is real, and has now been driven end to end
through two live browsers rather than only through scripts —
`app/e2e-two-browsers.mjs` plants a keypair in each context, funds both,
and then only ever clicks: claim the starter kit, mint the deck, queue,
play, settle. It watches the lamports on chain, not the UI's word for it.

Closing it turned up four defects that no unit could have caught, because
each component passed in isolation:

| | |
|---|---|
| `end_match_log` undelegated on the **first** claim | the second seat was locked out and `settle_from_log` was unreachable |
| its `!log.ended` guard | rejected that second claim anyway — the first claim sets `ended` |
| `requireSigner` in three files, plus `openSession` | demanded `adapter?.publicKey` while `canSign` said yes, so every guest write threw invisibly |
| `canStake` was `signer() !== null` | the Arena said "Escrowed onchain" and not one lamport moved |

**A new wallet could not play at all.** Not a caveat — a wall. `mint_card`
requires holding the coin, so a stranger could not mint one fighter, field
a deck, or reach a staked match. Every screen worked and the loop was
unreachable. `server/faucet.js` hands out 0.35 SOL and eight coins, once
per address, signed by a key whose only power is spending what it holds.

Guests were also crippled for no reason: a guest address already **was** a
real ed25519 public key, and only message-signing was wired. It signs
transactions now on devnet, and the copy says plainly that the key lives
in the browser and dies with site data.

Recovery is proven rather than assumed: `resolve-stuck.ts` claimed three
real stranded pots on devnet and freed 48 locked cards through
`claim_timeout`.

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
| Live E2E, both sites, mobile + desktop | **92/92** |

The API is deployed at `mempire-api-19110f59a37d.herokuapp.com`, so clans,
ranked and the leaderboard are live. Every mutating route demands an ed25519
signature over a timestamped, per-action message; verified against the running
service that a correct signature is accepted, and that a cross-action replay, a
signature for someone else's address, and an expired signature are each
refused with 401.

Guest identity is now a real ed25519 keypair generated in the browser, so a
guest can prove who they are exactly as a wallet can. Its secret key is stored
unencrypted, which is appropriate for what it guards — a devnet ladder position
and a clan tag — and must never be used for anything holding value.
