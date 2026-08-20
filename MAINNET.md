# Mainnet launch — runbook and budget

Everything code-shaped is done and verified. What remains is the ordered
sequence below, and each step names what it costs. Programs deploy with the
**same IDs** as devnet (the deploy keypairs in `chain/target/deploy/` *are* the
IDs), so nothing in the client changes per cluster except env vars.

## The number: ~3.2 SOL

Almost all of it is **recoverable rent, not spend**. Solana charges a
rent-exemption deposit sized to the program's bytes; `solana program close`
returns it to the authority. Actual consumed cost at launch is about 0.05 SOL
in transaction fees.

| Item | Size | SOL |
|---|---|---|
| `mempire` — lean build (`--no-default-features`) | 463,456 B | **3.23** |
| $MEMPIRE mint + config + treasury ATA | | 0.02 |
| 36 asset registrations | | 0.06 |
| Deploy fees + priority | | 0.05 |
| **Total to be live on mainnet** | | **≈ 3.36** |

Rent scales linearly with bytes at 6,960 lamports each, so the whole budget is
a size decision. Measured, from this repo's own builds:

| Build | Bytes | SOL | What it adds |
|---|---|---|---|
| lean (`--no-default-features`) | 463,456 | 3.23 | the whole game: roster, decks, chests, escrowed PvP, settlement, timeouts |
| `--features nft` | 594,224 | 4.14 | cards mint as Metaplex 1-of-1s, visible in wallets and explorers |
| `--features rollup` | 574,624 | 4.00 | MagicBlock ER: plays land on a rollup mid-match, VRF chests, on-chain play log |
| default (both) | 704,432 | 4.90 | everything — this is what devnet runs and what the 92-item plan verified |

**Deploy lean, grow into the rest.** `solana program extend` plus an upgrade
adds bytes later, so the deferred features cost their difference when revenue
pays for them — not upfront. Nothing about the money path changes: matches
escrow and settle identically in every build, because settlement reads the two
seats' claims off the log whether that log ever visited a rollup or not.

Two more programs stay undeployed at launch and are genuinely optional:

| Program | SOL | Why it can wait |
|---|---|---|
| `mempire_rollup` | 3.07 | VRF chest rolls + the play-by-play log. Without it chests roll from a local seed and the UI says so. |
| `mempire_amm` | 1.96 | The $MEMPIRE/USDC pool. The swap screen refuses honestly when no pool exists on the current cluster. |

## Pre-funding — already done, cost nothing

- [x] Mainnet $MEMPIRE mint keypair → `chain/.mempire-mint-mainnet.json`
      (gitignored), address `EzN1R1qbU4Vx1XC8FJFKuLJxN8hjxvMNipHi3uLBPAcU`,
      baked into the binary by the `mainnet` cargo feature.
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
3. **Mint $MEMPIRE** with `chain/.mempire-mint-mainnet.json` (6 decimals), set
   its metadata, mint the initial supply to the treasury, then decide the mint
   authority — null for a fixed supply, or the multisig.
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
