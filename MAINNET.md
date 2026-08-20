# Mainnet launch — runbook and budget

Everything code-shaped is done and verified. What remains is the ordered
sequence below, and each step names what it costs. Programs deploy with the
**same IDs** as devnet (the deploy keypairs in `chain/target/deploy/` *are* the
IDs), so nothing in the client changes per cluster except env vars.

## Three versions, three price points

You asked for 1 SOL and I could not get there honestly — 1 SOL buys ~144 KB of
program, and the simplest program in this repo (the AMM: init_pool, swap,
liquidity) is already 282 KB. Anchor's own runtime plus any real logic lands
past that floor. So instead: three versions, each a real thing you can ship.

| | What ships | SOL |
|---|---|---|
| **v1** | $MEMPIRE launched on Bags + the game free-to-play | **≈0.1** |
| **v2** | v1 + escrowed PvP settling through a MagicBlock rollup | **≈4.3** |
| **v3** | v2 + NFT cards + VRF chests + the play-by-play log | **≈8.2** |

Each version is a superset of the one before, and nothing is thrown away
between them — `solana program extend` grows the deployed program in place.

### v1 — the token and a free game · ≈0.1 SOL

Launch **$MEMPIRE on [bags.fm](https://bags.fm)** instead of deploying our own
AMM. Bags runs on Meteora's Dynamic Bonding Curve: trading happens against a
virtual pool immediately and graduates into a real DAMM pool at a threshold, so
the market makes itself. Launch costs about 0.02 SOL in fees and a Jito tip
(keep 0.1 SOL in the wallet); an initial dev buy is optional.

This *deletes* a line item rather than deferring one. The old plan had a 1.96
SOL AMM deploy plus discretionary USDC to seed the pool. Bags replaces both,
and pays: the creator earns **1% of all trading volume, forever, in SOL**, plus
a Dexscreener listing for discoverability.

The game itself needs no deploy to be playable — it already runs free at
play.mempire.fun with the full roster, decks, chests, clans, ladder and bot and
PvP matches. What a mainnet program buys is real-money pots, and nothing else.

### v2 — real pots, on a rollup · +4.17 SOL

`--features mainnet,rollup`, 599,040 bytes. Escrowed PvP, cards on chain,
merge-to-level, timeouts, settlement — and the settlement log delegated to a
**MagicBlock ephemeral rollup**, where both seats' claims land in tens of
milliseconds and come home through `commit_and_undelegate`.

The lean build (`--features mainnet`, 469,736 bytes, **3.27 SOL**) is the same
game with no MagicBlock at all. The rollup is therefore a **0.90 SOL** decision,
and it is the one place in this ladder where I'd argue against the cheaper
option — see *Where MagicBlock sits* below.

### v3 — everything · +3.84 SOL

`nft` adds Metaplex 1-of-1 cards (+0.77 of program rent). Deploying the
separate `mempire_rollup` program (+3.07) adds what a delegated settlement log
cannot do alone: VRF-rolled chests, the play-by-play log with plays landing
mid-match, PER sealing, and session keys. Fund it from rake, not from pocket.

### The rent is a deposit, not a spend

Solana charges deploy rent as a rent-exemption deposit sized to the program's
bytes; `solana program close` returns it to the authority. Actual consumed cost
is about 0.05 SOL in transaction fees. Measured from this repo, current code:

| Build | Bytes | SOL | Adds |
|---|---|---|---|
| `mainnet` (lean) | 469,736 | 3.27 | the whole game, no MagicBlock |
| `mainnet,nft` | 580,496 | 4.04 | Metaplex cards |
| `mainnet,rollup` | 599,040 | 4.17 | **ER delegation + commit** |
| `mainnet,nft,rollup` | 710,304 | 4.94 | both |
| `mempire_rollup` (separate program) | 441,432 | 3.07 | VRF, play log, PER, sessions |

Because rent comes back, "v2 costs 0.90 more than lean" means 0.90 SOL *locked*,
not 0.90 SOL *gone*.

Settlement is byte-identical in every build — the two seats' claims are the same
bytes whether the log visits a rollup or stays on base layer — so moving up a
version never migrates data or changes the money path.

## Where MagicBlock sits — and what the accelerator would actually see

Short answer: **the lean 3.27 build has no MagicBlock in it, so v2 has to be the
4.17 build or the integration is devnet-only.**

MagicBlock appears in this repo in two places, and they cost very differently:

**In the core program, behind `--features rollup` (+0.90 SOL).** `MatchLog` is
delegated to an ER on the base layer, `end_match_log` runs *on the rollup*, and
the result commits and undelegates in one intent bundle. Delegation is
restricted to a player in that match naming the validator, because whoever
holds a delegated account is who commits its state — an open delegate would let
a hostile validator commit an arbitrary winner. This is a real ER integration:
one delegated account, executing under its own program owner, settling back to
Solana.

**In the separate `mempire_rollup` program (+3.07 SOL).** Four more MagicBlock
products: **VRF** for chests (`request_chest` → `callback_chest`, so the reward
is verifiably random rather than seeded locally), a **play-by-play log**
(`play_card`, `checkpoint`) at ER latency, **PER** sealing through
`EphemeralPermission` (`seal_log` / `reseal_log` / `unseal_log`), and **session
keys** so a player signs once per match instead of once per play.

Mainnet fleet checked live today via the status API: `er`, `rpc_router`,
`pricing_oracle` and `vrf_oracle` all **up** in asia, europe and usa. The `tee`
region publishes no `rpc_router` at all — that is structural, not an outage;
PER talks to the TEE ER endpoint directly, and its `er` and `vrf_oracle` are up.

**The recommendation.** Ship v2 at 4.17 with `rollup`. Deferring it saves 0.90
SOL of refundable deposit and costs the one claim that is hardest to make later
— that the deployed mainnet program uses MagicBlock. All four products already
run on devnet, so the integration is demonstrable either way; the question is
only whether mainnet matches devnet or lags it. If the budget is truly 3.3, ship
lean and be plain that mainnet is the base-layer subset — but the gap between
3.27 and 4.17 is the cheapest part of this whole ladder to close later, and the
most expensive story to have to explain.

## Settled: how a new player gets their first $MEMPIRE

This was the last open product question, and it is now closed in code.

Chests pay cards, not $MEMPIRE, and on devnet the faucet drips 2,000. There is
no faucet on mainnet, so a new player would have arrived with none — while
merging (100 × level), chest skips, the shop and clan charters all price in
$MEMPIRE. **A win now pays 50 $MEMPIRE**, so the currency is earned by playing,
like everything else after the pivot. Buying on Bags stays available for anyone
in a hurry, but nothing requires it.

Two properties worth keeping if this is ever tuned. The payout is a `const`,
not a `Config` field, because `Config::SIZE` is exact and widening it would
orphan the live config account. And all three reward accounts are `Option`, so
an empty or missing vault can never strand a pot — settlement pays out
normally and skips the bonus. Verified on devnet, match #78: winner
6,165 → 6,215, vault 2,000 → 1,950.

## Pre-funding — already done, cost nothing

- [x] A mainnet $MEMPIRE mint keypair exists at
      `chain/.mempire-mint-mainnet.json` (gitignored), address
      `EzN1R1qbU4Vx1XC8FJFKuLJxN8hjxvMNipHi3uLBPAcU`, currently baked in by the
      `mainnet` cargo feature. **If $MEMPIRE launches on Bags instead, Bags
      creates the mint and this keypair is unused** — replace the constant with
      the address Bags returns (see the sequencing note in v1).
- [x] Mainnet roster: 36 assets built from Jupiter's **verified** token list
      with per-mint market data → `app/src/lib/mainnet-coins.json`,
      `server/mainnet-coins.json`. Rebuild with
      `node chain/build-mainnet-registry.mjs`. Identity never comes from symbol
      search — that returned a "BTC" with $8B of spoofed liquidity.
- [x] Both binaries build and were byte-verified to carry their own mint.
- [x] MagicBlock mainnet fleet re-checked live: ER, router, pricing oracle and
      VRF oracle all up across asia/europe/usa.
- [x] The Bags market is wired end to end (`server/bags.js` holds the key,
      `app/src/chain/market.ts` calls our own origin) and reports
      `configured: false` until the token exists. Nothing to build at launch —
      set `BAGS_API_KEY` and `MEMPIRE_MINT` on the relay and it goes live.
- [x] A win pays `WIN_REWARD` (50 $MEMPIRE) from a `[b"rewards"]` PDA vault.
      **Fund that vault at launch** — the accounts are optional, so an unfunded
      vault settles the pot normally and simply pays no bonus.

## Launch sequence

1. **Keys.** A fresh treasury — a Squads multisig, or at minimum a keypair
   generated offline and backed up. The devnet treasury derives from a public
   string in this repository, which is why `set-treasury.ts` refuses to run
   against mainnet. Decide the upgrade authority (same multisig recommended);
   today one hot wallet holds upgrade authority, config admin and mint
   authority, which is a single point of total failure.
2. **Bake the mint, then build and deploy.**
   ```
   cd chain
   node scripts/bake-mainnet-mint.mjs --check      # refuses if not a live mint
   node scripts/bake-mainnet-mint.mjs <mint Bags returned>
   anchor build -- --no-default-features --features mainnet,rollup
   solana program deploy target/deploy/mempire.so \
     --program-id target/deploy/mempire-keypair.json --url <mainnet rpc>
   ```
   Budget the full 4.17 in the deployer *before* starting: a failed attempt
   strands a buffer, and `solana program close --buffers` reclaims it. Drop
   `,rollup` for the 3.27 lean build, having read *Where MagicBlock sits*.

   `--check` is not optional politeness. The mint currently baked into the
   source (`EzN1R1qb…`) was generated offline and **never used to create a
   mint**, so it does not exist on mainnet — deploy with it and every $MEMPIRE
   constraint refuses, after the 4.17 is spent. The script refuses any address
   that is not a live mint, and warns if decimals are not 6.

   Measured on devnet: the *first* deploy costs the full rent, but an upgrade
   into an already-allocated program account costs about **0.003 SOL**. The
   account does not shrink for a smaller binary, so removing a feature later
   never refunds rent.
3. **$MEMPIRE already exists** — it was launched on Bags in v1, which is why
   v1 comes first. See the sequencing note below: its mint address has to be
   known before the program is built.
4. **init_config** with mainnet economics. The program now enforces sane
   ranges: `match_timeout_secs = 86400`, `rake_bps = 1000`,
   `tie_rake_bps = 500`, `mint_fee_lamports` = launch price, treasury = the
   multisig from step 1.
5. **Register the 36 assets** from `server/mainnet-coins.json`.
6. **Relay** (Railway): set `SOLANA_RPC` to the mainnet endpoint — that one
   variable flips the registry, stops the faucet routes from registering, and
   points chain verification at mainnet. Set
   `CORS_ORIGIN=https://play.mempire.fun`, rotate the Mongo credentials, and do
   **not** set `FAUCET_SECRET`.
7. **App build:** `VITE_CLUSTER=mainnet-beta`, `VITE_RPC_URL=<mainnet rpc>`
   — they must agree or the app refuses to boot — and **`VITE_FEATURE_NFT=0`**,
   because v2 compiles `nft` out. Without it the card sheet offers *Mint as NFT*
   and the program answers with a refusal; the error is translated to a readable
   sentence either way, but there is no reason to offer the button at all. Build *after* step 5 writes
   the registry. Deploy to Vercel.
8. **Smoke test** with two funded wallets at the smallest tier: mint a card,
   merge a duplicate, and settle one staked PvP match end to end.

## Bags — already wired, waiting on a key

Built and deployed, not pending. Two files:

- `server/bags.js` — the relay proxies `/api/market`, `/api/market/quote` and
  `/api/market/swap`. Bags authenticates with an `x-api-key`, and a key in a
  browser bundle is a key anyone can spend, so the relay holds it and the client
  only ever talks to our own origin.
- `app/src/chain/market.ts` — quotes and the unsigned swap. The relay never
  holds a player's key: it builds, the wallet signs. `requestId` ties the fill
  to the exact quote shown.

Absent is a state, not an error. With no key the routes answer
`configured: false` and quotes return **503** rather than inventing a price; the
swap screen prefers Bags, falls back to a local pool that matches its cluster,
and refuses with the reason when neither exists. All three behaviours verified
live on the deployed relay.

**To go live:** set `BAGS_API_KEY` (from dev.bags.fm) and `MEMPIRE_MINT` on the
relay. No rebuild. Creator fees — the 1% of volume, forever — are claimed
through `sdk.fee.getAllClaimablePositions` in the Bags SDK; that is the one
piece not yet wired, because there is nothing to claim until the token trades.

**Sequencing constraint, and it is load-bearing.** The program bakes
`MEMPIRE_MINT` in at compile time, so the token has to exist *before* the
program is built. Launching on Bags in v1 gives you that address; bake it,
then build and deploy in v2. Doing it the other way round means a second
deploy. (If that ordering ever becomes inconvenient, move the mint from a
constant to a `Config` field set at `init_config` — safe on a fresh mainnet
deploy, though it would orphan the existing devnet config account.)

## When revenue arrives

```
solana program extend <program-id> <additional-bytes>
anchor build -- --no-default-features --features mainnet,nft,rollup
solana program deploy ... --program-id ...
```

Order by what players ask for. NFTs (+0.77 SOL of rent on top of v2) make cards
visible in wallets. Deploying `mempire_rollup` (3.07, its own program ID) adds
VRF chests, the play-by-play log, PER sealing and session keys.

## Deliberately deferred, with reasons

- **Result-dispute griefing** (`AUDIT.md` C9): a loser can claim the opposite
  result, void the match and get their own stake back. They cannot steal — only
  deny the winner the pot. Closing it needs the play log verified onchain.
- **AMM `init_pool` is permissionless** — first caller sets the fee for a mint
  pair. Mitigate by opening the canonical pool in the same batch as the deploy.
- **One relay replica.** Matchmaking queues live in memory; a deploy drops
  queued players, never matches.
- **Unaudited programs.** Real audits cost more than this entire budget. Keep
  tier caps small until one happens.

## Security debts to clear regardless

- Revoke the GitHub PAT (github.com/settings/tokens) — still live.
- Revoke the Heroku API token (dashboard.heroku.com/account/applications).
- Rotate the MongoDB Atlas password.
- Back up `mobile/keys/mempire-release.keystore` and
  `chain/.mempire-mint-mainnet.json` somewhere that is not this SSD. That mint
  keypair *is* the mainnet currency.
