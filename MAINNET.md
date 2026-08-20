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
| **v2** | v1 + escrowed real-money PvP on mainnet | **≈3.4** |
| **v3** | v2 + NFT cards + MagicBlock rollup | **≈8.2** |

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

### v2 — real pots · +3.23 SOL

The lean program (`--no-default-features`), 463,456 bytes. Escrowed PvP,
cards on chain, merge-to-level, timeouts and settlement. Cards are program
accounts rather than NFTs, and chests roll from a local seed that the UI
labels as such.

### v3 — everything · +4.8 SOL

`nft` adds Metaplex 1-of-1 cards (+0.91 of program rent). `rollup` adds
MagicBlock ER — plays landing on a rollup mid-match, VRF-rolled chests, an
on-chain play log (+0.77 in the core program, plus 3.07 to deploy
`mempire_rollup`). Fund it from rake, not from pocket.

### The rent is a deposit, not a spend

Solana charges deploy rent as a rent-exemption deposit sized to the program's
bytes; `solana program close` returns it to the authority. Actual consumed cost
is about 0.05 SOL in transaction fees. Measured build sizes, from this repo:

| Build | Bytes | SOL | Adds |
|---|---|---|---|
| lean (`--no-default-features`) | 463,456 | 3.23 | the whole game |
| `--features nft` | 594,224 | 4.14 | Metaplex cards |
| `--features rollup` | 574,624 | 4.00 | rollup + VRF |
| default (both) | 704,432 | 4.90 | everything |
| `mempire_rollup` (separate program) | 441,544 | 3.07 | needed only by v3 |

Settlement is byte-identical in every build — the two seats' claims are the
same bytes whether the log visits a rollup or stays on base layer — so moving
up a version never migrates data or changes the money path.

### Open decision before v2: how a new player gets their first $MEMPIRE

Chests pay cards, not $MEMPIRE, and on devnet the faucet drips 2,000. There is
no faucet on mainnet, so a new player arrives with none — and merging
(100 × level), chest skips, the shop and clan charters all price in $MEMPIRE.
Three ways out, and this is a product call rather than a technical one:

1. **Earn it by winning** — add $MEMPIRE to chest payouts. Fits the pivot best:
   everything else in the game is earned by playing.
2. **Buy it on Bags** — honest and zero work, but it puts a purchase between a
   new player and their second card level.
3. **Treasury airdrop** — needs a stash, which means an initial dev buy at
   launch and a sybil rule.

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
- [x] MagicBlock mainnet fleet confirmed live (for when the rollup is added).

## Launch sequence

1. **Keys.** A fresh treasury — a Squads multisig, or at minimum a keypair
   generated offline and backed up. The devnet treasury derives from a public
   string in this repository, which is why `set-treasury.ts` refuses to run
   against mainnet. Decide the upgrade authority (same multisig recommended);
   today one hot wallet holds upgrade authority, config admin and mint
   authority, which is a single point of total failure.
2. **Build and deploy the lean program.**
   ```
   cd chain
   anchor build -- --no-default-features --features mainnet
   solana program deploy target/deploy/mempire.so \
     --program-id target/deploy/mempire-keypair.json --url <mainnet rpc>
   ```
   Budget the full 3.23 in the deployer *before* starting: a failed attempt
   strands a buffer, and `solana program close --buffers` reclaims it.
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
7. **App build:** `VITE_CLUSTER=mainnet-beta` and `VITE_RPC_URL=<mainnet rpc>`
   — they must agree or the app refuses to boot. Build *after* step 5 writes
   the registry. Deploy to Vercel.
8. **Smoke test** with two funded wallets at the smallest tier: mint a card,
   merge a duplicate, and settle one staked PvP match end to end.

## Wiring Bags into the swap screen

The Bags TypeScript SDK (`@bagsfm/bags-sdk`, needs a key from dev.bags.fm and
an RPC) exposes exactly what the swap screen already does against the local
AMM:

```ts
const quote = await sdk.trade.getQuote({
  inputMint: 'So11111111111111111111111111111111111111112', // wSOL
  outputMint: MEMPIRE_MINT,
  amount: 1_000_000_000,
  slippageMode: 'dynamic',
});
```

`app/src/chain/amm.ts` is already the single place quotes and swaps are built,
and `AMM_CONFIG_MATCHES_CLUSTER` already makes the screen refuse honestly when
no pool exists for the current cluster — so this is a swap of one module's
internals, not a UI change. The SDK also covers claiming the creator fees
(`sdk.fee.getAllClaimablePositions`), which is how the 1% royalty is collected.

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
anchor build -- --features mainnet,nft          # or mainnet,nft,rollup
solana program deploy ... --program-id ...
```

Order by what players ask for. NFTs (+0.91 SOL of rent) make cards visible in
wallets. The rollup (+0.77 in the core program, plus 3.07 to deploy
`mempire_rollup`) adds VRF chests and the on-chain play log.

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
