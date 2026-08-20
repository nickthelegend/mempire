# Audit — 4 Aug 2026, closed out 6 Aug

Five parallel audits of the whole repo. Findings are recorded here **whether or
not they are fixed**, because a known unfixed defect that nobody wrote down is
indistinguishable from one nobody found.

Severity is by what an attacker gains, not by how hard it was to spot.

### One word, two meanings

A **stake** in this document is SOL a player wagers on a match. The program
escrows both sides, settlement pays the winner, and the house takes 10% — 5% on
a draw. That is unchanged, and every finding about it stands as written.

**Staking a coin into a card** was a different mechanic: lock tokens in a card
and the locked USD set its level. It was retired on 20 Aug 2026. `stake`,
`request_unstake` and `claim_unstake` are gone from the program, and with them
the vaults, the 2% unstake fee, the 72h/60s cooldown, and the USD level
thresholds. Every staked token was returned to its owner before the
instructions were removed — taking away the only way to withdraw is the exact
class of bug this audit exists to catch. Cards now go 1→10 by winning: a win
earns a chest, chests drop duplicates, and merging a duplicate promotes the
card. Levels are earned, never bought, and nothing in the game custodies, locks
or stakes a player's own holdings. The coins, stocks and crypto in the roster
are characters, not collateral.

Findings that audited the retired mechanic are kept — a fix that was real is
still a record — and marked where they no longer describe live code.

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
| C10 | `mempire` `ClaimUnstake` | **MEDIUM** `treasury_tokens` was constrained on `.mint` alone, so the unstaker passed their own account and refunded their own fee. Tied to `config.treasury` on 6 Aug; the instruction itself was removed on 20 Aug with the rest of token staking, so there is no longer a fee account to mis-constrain. |
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
required holding the coin, so a stranger could not mint one fighter, field
a deck, or reach a staked match. Every screen worked and the loop was
unreachable. `server/faucet.js` hands out 0.35 SOL and eight coins, once
per address, signed by a key whose only power is spending what it holds.

That gate is gone as of 20 Aug: `mint_card` charges its 0.02 SOL and checks
the *coin* — liquidity floor and age — not the minter's wallet. Holding the
underlying token is not required to mint or field its card. The faucet still
matters on devnet, because a new player needs SOL for fees and a first wager,
but reaching the loop no longer depends on being handed tokens.

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
- **VRF.** The callback is gated on `scoped_vrf_identity`, so only the VRF program can deliver. Replays and cancelled-request callbacks are rejected by a `(slot, nonce, state)` re-check. The player's `caller_seed` picks among 256 inputs to an oracle they cannot evaluate — no grinding path. This is `mempire-rollup`, which ships with the rollup subsystem and not with the lean launch build.
- **Rake arithmetic.** `rake + payout == pot` exactly in all three payout paths. No double-settlement; all paths require `Active` and set `Settled`.
- ~~**Unstaking.**~~ **Superseded 20 Aug.** It held while it existed — `has_one = owner` plus a PDA-authority vault, no cross-player unstake, and the 72h two-step could not be replayed. The instruction, the vault and the cooldown were then removed, after the last staked token had been returned. There is no unstake path left to audit.
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

**What those runs cover, now that there are two builds.** On 20 Aug the two
heavy subsystems became cargo features, both on by default: `nft` (Metaplex
1-of-1 cards) and `rollup` (MagicBlock delegation, and with it the VRF chests in
`mempire-rollup`). Devnet keeps the full build — 710,304 bytes, 4.94 SOL of
deploy rent — so the runs above are still runs against what devnet answers with.
The mainnet launch build is `--no-default-features --features mainnet,rollup`:
599,040 bytes, 4.17 SOL, linking `rollup` but not `nft`. Stripping `rollup` too
gives the lean 469,736 bytes / 3.27 SOL, which links neither. Deploy rent is a
refundable deposit in every case; `solana program close` returns it.

Settlement does not depend on the rollup and never did. The claims are the same
bytes whether the log lives on base layer or on an ER, so `e2e-full-flow`,
`e2e-security` and the escrow findings apply to both builds unchanged. What only
the full build carries is the delegation and chest surface — `e2e-per-vrf`, and
the findings above that name `delegate_*`, `unseal_log`, `open_session` and
`request_chest`.

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

---

## C9 — a disputed match was a race for the whole pot

**CRITICAL. Found and fixed 7 Aug 2026.**

`settle_from_log` refuses to pay when the two seats claim different winners,
which is correct — one of them is lying and the program cannot tell which. But
refusing left the match `Active`, and `claim_timeout` pays whichever player
calls it. So after the deadline both seats were eligible and it became a race:

> a client that reported the opposite winner, then called `claim_timeout` the
> moment the deadline passed, took the entire pot.

Stalling strictly dominated playing honestly, and the honest seat's only
counter was to be faster. The in-code comment claimed a cheat could turn a loss
into a refund but not a win — that was true of `settle_from_log` alone and not
of the pair.

**The fix.** `claim_timeout` now reads the match log, which is pinned by seeds
so a caller cannot omit it or substitute a blank account to hide a
disagreement. Both seats having spoken and contradicted each other is a
*dispute*; anything else — nobody spoke, one seat spoke, no log, log still
delegated — is the abandonment the instruction was written for. A dispute
refunds both stakes in full and takes no rake, because charging it would take
money from the honest seat to settle something the house could not resolve.

Verified on devnet against match #49: claims `[0, 1]`, `claim_timeout` called
by the seat that lied, result `state=Settled winner=2`, **both seats +0.0100
SOL** — their own stake back, no pot — and all sixteen cards released.
`scripts/e2e-integrity.ts` reproduces it from a fresh match.

**Still open.** A cheat can force that refund and so decline any loss. It costs
them nothing and gains them nothing, which is griefing rather than theft, but
it is not honest play. Closing it needs the result attested by something that
watched the match rather than derived from what the seats claim — the relay
already sees every input from both clients and is the obvious referee.

---

## C10 — `claim_timeout` still paid the first caller in two of three cases

**CRITICAL. Found by audit, fixed 8 Aug 2026.**

The C9 fix detected only *disagreement*. Every other log shape fell through to
the payout, which pays whichever player signs — so the cheapest cheat was
untouched, and worse, C9 made it the best one:

> a loser who simply never calls `end_match_log` leaves `claims = [0, 3]`. The
> log stays delegated, `settle_from_log` is permanently unreachable because it
> needs both claims, and the honest winner's only remaining path is
> `claim_timeout` — the same instruction the liar fires at the deadline to take
> the pot.

Lying cost the cheat the pot; silence won it. Not even a race: the honest
client schedules its recovery at `deadline + 5s`, so the attacker firing at
`deadline + 0` wins deterministically.

The second case was worse in principle. With `claims = [0, 0]` committed home —
an agreed, undisputed on-chain result saying Alice won — Bob calling
`claim_timeout` still took the pot, because the test was for *inequality*.

**The fix.** The log now decides eligibility, not just the dispute:

| log | outcome |
|---|---|
| both spoke, disagreed | refund both, no rake |
| both spoke, agreed | rejected — that is a settlement, use `settle_from_log` |
| exactly one spoke | only that seat may claim; it proved it was present |
| nobody spoke / no log / still delegated | genuine abandonment, either may claim |

## C11 — `deck_hash` was client-supplied and read by nobody

**HIGH. Fixed 8 Aug 2026.**

`validate_and_lock_deck` derived `power` from the locked cards and `join_match`
enforced the power band — but nothing tied the deck the *simulation* ran to
those cards. `deck_hash` was an instruction argument, stored verbatim, and read
by no instruction and no client.

So: lock eight freshly minted level-1 cards, pass the bracket against any
level-1 opponent, then send the relay eight level-10 cards. `sanitiseDeck`
accepts them, both clients hash the same fabricated deck so no desync fires, and
the wagered match is won with a deck the program never locked.

The commitment is now derived on chain — `sha256(coin_mint || level)` over the
eight cards in the order they were locked — and the argument is ignored.
Verified against the deployed program: a caller passing `0xAA…` gets
`7db3b472…` stored, which matches the sha256 of the cards it actually locked.

**Still open:** the client does not yet compare its opponent's relayed deck
against that commitment. Deriving it is what makes the check *possible*; the
check itself is the other half.
