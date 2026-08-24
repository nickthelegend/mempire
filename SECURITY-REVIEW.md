# Mempire — AI-assisted security review

**This is not a professional security audit.** It is a structured review carried
out by AI agents, with every finding verified against the deployed programs and
the fixes proven on devnet. It is evidence of diligence, not a guarantee of
safety, and it is not a substitute for a human audit by a specialist firm. The
programs remain unaudited in the industry sense of that word.

| | |
|---|---|
| **Date** | 24 August 2026 |
| **Method** | `solana-auditor` skill, 9 parallel agents, `--deep` |
| **Scope** | `mempire` · `mempire-rollup` · `mempire-amm` — 4,573 lines of Rust |
| **Framework** | Anchor 0.32.1 · MagicBlock ER SDK 0.16.2 · VRF SDK 0.4.1 |
| **Confirmed and fixed** | 6 |
| **Confirmed, deferred with reasons** | 5 |
| **Rejected after verification** | 4 |

---

## What was reviewed, and how

Nine agents examined every non-test Rust file in the workspace, each from a
different angle: attack-vector scanning, math and precision, access control,
economic security, execution tracing, invariants, peripheral files, first
principles, and a deeper Solana-protocol pass.

Agents produce hypotheses, not results. Every finding below was re-read against
the actual source before being accepted, and four were rejected as incorrect on
that reading. The fixes were then deployed to devnet and demonstrated — in the
most serious case, by carrying out the attack and showing it no longer pays.

---

## Fixed

### 1 · A losing player could take the whole pot — *critical*

`mempire::claim_timeout`

`claim_timeout` decides who may claim by reading `MatchLog.claims`, guarded by
`log_info.owner == &crate::ID`. Under the launch build the log is delegated to a
MagicBlock rollup for the whole match, so it is owned by the delegation program
and that read yields `None` — indistinguishable from "no log was ever created".
Both fell through to *"genuine abandonment, either may claim"*.

The protection disabled itself in exactly the case its own comment describes: a
loser who simply never claims could call this at the deadline and take the pot.
The account's documentation even asserts the handler "distinguishes those from a
real dispute by ownership". It did not.

**Fixed** — a log that exists but cannot be read is now treated as a dispute:
both stakes refunded, no rake. It cannot reward a stall, and cannot rob the
winner of an opponent who genuinely vanished of more than the upside.

**Demonstrated** on devnet against match #83, whose log was authentically stuck
delegated with `claims [3,3]`. The seat that had just lost 1–0 called
`claim_timeout`:

```
before   winner A 1.083505 · loser B 0.729484
after    winner A 1.133505 · loser B 0.779479
deltas   A +0.050000       · B +0.049995
state    Settled, winner 2 (void — both refunded)
```

Before the fix, that call paid the loser the 0.09 pot and left the winner with
nothing.

### 2 · Either seat could freeze the match and force a timeout — *high*

`mempire::checkpoint`

`checkpoint` wrote `log.last_tick`, the same cursor `play_card` gates on, and
the tick was unbounded above. A losing seat could checkpoint at `u32::MAX`, after
which every play by *either* seat failed `StaleTick` for the rest of the match —
converting a lost position into a forced timeout, which is a payout path rather
than a loss.

**Fixed** — a checkpoint attests a state hash and no longer moves the play
cursor.

### 3 · One seat could consume the whole input log — *high*

`mempire::play_card`

`MAX_PLAYS` was a single 128-entry budget shared by both seats, and the tick
guard is non-strict, so one seat could spend all of it at a single tick. The
opponent's inputs then had nowhere to go, the two seats necessarily disagreed at
the end, and the pot voided — strictly better for whoever was losing.

**Fixed** — each seat gets half the log, counted from the entry's own seat field.

### 4 · A stranger could burn the winner's reward — *medium*

`mempire::settle_from_log`

`settler` said *"either player may settle"* in a comment and enforced nothing,
while the three reward accounts are optional and a mismatch on them is skipped
rather than raised. Any third party could settle a finished match with the
reward omitted: the pot paid correctly, the state became `Settled`, and the
winner's 50 $MEMPIRE became permanently unpayable, because every settlement path
requires `Active`.

**Fixed** — `settler` is pinned to the two seats. Verified that a stranger is
refused and a real player passes through to the next check.

### 5 · The VRF guard failed open — *high (v3)*

`mempire_rollup::chests::is_ephemeral_queue`

The guard gated the *strict* branch behind a `mainnet` feature that is opt-in,
whose crate default is empty, and which no build or deploy line in the repo
passes for this program. An ordinary `anchor build` therefore produced the binary
that accepts the SDK's test queue — whose fulfiller is documented as usable by
anyone — under a program id registered for mainnet. Chest tiers would have been
chosen by whoever answered the oracle first, inverting the published 62/26/9/3
table to whatever the requester wanted.

**Fixed** — the polarity is reversed. Production-only is what a plain build
gives you; the test queue is an explicit `testqueue` opt-in for localnet and
devnet. Devnet was redeployed with that flag and its chest rail still shows the
🎲 that marks a genuine VRF roll.

### 6 · A player could name the validator that authors their own rewards — *high (v3)*

`mempire_rollup::delegate_chests`

The caller-supplied validator was forwarded straight into `DelegateConfig`. A
delegated account's authority is what computes and commits its state, so the
rail's owner could choose who authors `earned`, every slot's tier, and the
randomness behind it — the chest economy written by its beneficiary.

**Fixed** — router-assigned, matching `mempire::delegate_match_log`. (The AMM
deleted its equivalent `delegate_pool` outright for the same reason.)

---

## Confirmed, deferred — with reasons

These are real. They are not fixed, and the reasons are stated rather than
implied.

**The rollup's match log is not bound to a real match.** `mempire_rollup::init_log`
accepts `match_id` and `players` as instruction data with no reference to the
escrowed `MatchAccount`, so two self-owned wallets can fabricate a match and mint
chest entitlements for transaction fees — and can squat the log PDA of a real
match, denying it. The sibling handler `mempire::init_match_log` does this
correctly. **Not fixed** because the correct repair is a cross-program account
read, which is a design change rather than a patch, and `mempire_rollup` is not
deployed in the v2 launch. **It is a v3 blocker.**

**The win reward is farmable by self-play.** `join_match` rejects the same
*pubkey*, not the same person, so two wallets can wash-trade a match at a net
cost of the rake and mint 50 $MEMPIRE from the reward vault. **Not fixed**
because the remedy is a product decision — rate-limit per winner, scale the
reward below rake, or require distinct funding — not a bug fix.

**Match rent is never reclaimed.** Neither `MatchAccount` nor the base-layer
`MatchLog` has a close path; `cancel_match`'s comment claims it closes the
account and no `close` constraint exists. Roughly 0.016 SOL of player rent is
stranded per match. **Not fixed** because closing the match account would break
`release_cards`, which needs it to exist to free cards still locked to it.

**Selling a card's NFT conveys nothing.** `Card.owner` is written once at mint
and no instruction transfers it, so the 1-of-1 is a detached certificate; the
seller keeps the playable card and can even merge it away afterwards. **Not
fixed** — `nft` is not in the v2 build, and binding the two is a design change.

**The AMM's `init_pool` is permissionless.** Anyone can front-run the canonical
$MEMPIRE/USDC pool and fix its fee forever, and its vault ATAs are squattable at
predictable addresses. **Not fixed, and not planned** — $MEMPIRE launches on
[Bags](https://bags.fm) and `mempire_amm` is not deployed.

---

## Rejected after verification

Reported by agents, checked against the source, and found not to hold:

- **`upgrade_card` self-merge** — `require!(keep.key() != dupe.key())` and
  `keep.coin_mint == dupe.coin_mint` both present.
- **Deck of one card** — `validate_and_lock_deck` rejects a repeated coin, which
  also blocks passing one card eight times.
- **Fee redirection** — every fee-taking instruction pins its destination with
  `address = config.treasury`.
- **`migrate_card` type confusion** — no other account type in the program is
  116 bytes, so the claimed target does not exist.

---

## What this review cannot tell you

AI analysis cannot prove the absence of vulnerabilities. It reasons about code it
was shown, and it produced four confidently-worded findings here that were wrong
on a careful reading — which is the honest measure of how much weight a reader
should put on the rest.

What it *is*: nine independent passes over every line of the on-chain code, each
surviving finding re-derived from source, and the serious ones demonstrated by
carrying out the attack and showing the fix defeats it.

What would strengthen it: a human audit by a specialist firm, a bug bounty, and
on-chain monitoring. Until then the compensating controls are small stake tiers
and a settlement design that voids rather than pays when the two seats disagree
— a cheat costs the cheater the match; it cannot take the pot.

---

*Review workflow: [`solana-auditor`](https://github.com/sanbir/solana-auditor-skills),
lineage from [pashov/skills](https://github.com/pashov/skills), adapted for Solana.*
