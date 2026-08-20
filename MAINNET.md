# Mainnet launch — runbook and budget

Everything code-shaped is done and verified; what remains is the ordered
sequence below, and each step names what it costs. Programs deploy with the
**same IDs** as devnet (the deploy keypairs in `chain/target/deploy/` are the
IDs), so nothing in the client changes per cluster except env vars.

## What it costs

Rent is bytes × 6,960 lamports (rent-exempt, 2 years) on the programdata
account (binary + 45B header + 128B overhead). Binaries measured from this
repo's builds.

| Item | Size | SOL |
|---|---|---|
| `mempire` program | 739 KB | **5.15** |
| `mempire_rollup` program | 441 KB | **3.07** |
| `mempire_amm` program | 282 KB | **1.97** |
| $MEMPIRE mint + Metaplex metadata | | 0.02 |
| Config init + treasury ATA | | 0.01 |
| 36 CoinInfo registrations | | 0.06 |
| AMM pool + vaults + LP mint | | 0.01 |
| Deploy transaction fees (~1,600 writes) + priority | | 0.05 |
| **Hard total** | | **≈ 10.3** |
| Float for a failed-deploy buffer, retries, priority spikes | | 1.7 |
| **Recommended funding** | | **12 SOL** |

Notes on the number:
- During each deploy a buffer of the same size is funded and then consumed
  into the program account — the float covers a *failed* attempt stranding
  one until `solana program close --buffers` reclaims it.
- **Cheaper start (≈ 8.5 SOL): defer the AMM.** The swap screen already
  refuses honestly when no mainnet pool is configured; matches, mints,
  chests and clans have no dependency on it. Deploy `mempire` +
  `mempire_rollup` first, add the AMM when there's liquidity to seed anyway.
- Pool liquidity is a separate, discretionary number in USDC (the $MEMPIRE
  side is minted). The pool works at any depth; price impact at $500 USDC
  depth is what it is and the UI shows it.
- MagicBlock: ER execution is free to players; each delegated account gets
  10 sponsored commits, and re-delegation (which every match log does by
  construction) refreshes the quota. The long-lived chest rail should be
  re-delegated on a maintenance cadence or funded via the fee-vault path if
  it ever hits the cap.

## Pre-funding (free, already done)

- [x] Mainnet $MEMPIRE mint keypair generated → `chain/.mempire-mint-mainnet.json`
      (gitignored) — address `EzN1R1qbU4Vx1XC8FJFKuLJxN8hjxvMNipHi3uLBPAcU`,
      baked into the `mainnet` build via cargo feature.
- [x] Mainnet coin registry built from Jupiter-verified identities +
      DexScreener market data → `app/src/lib/mainnet-coins.json`,
      `server/mainnet-coins.json` (36 coins; identities never taken from
      symbol search — see `chain/build-mainnet-registry.mjs`).
- [x] Mainnet program binaries build (`anchor build -- --features mainnet`);
      artifacts preserved as `target/deploy/*-mainnet.so`.
- [x] MagicBlock mainnet fleet confirmed live (ER + router + VRF, three
      regions) via status.magicblock.app.

## Launch sequence (needs the 12 SOL on the deployer)

1. **Keys.** Fresh treasury — a Squads multisig, or at minimum a fresh
   keypair generated offline and backed up. The devnet treasury key derives
   from a public string in this repo; `set-treasury.ts` now refuses to run
   against mainnet for exactly that reason. Decide the upgrade authority
   (same multisig recommended) — today one hot wallet holds upgrade
   authority + admin + mint authority, which is a single point of total
   failure.
2. **Deploy** (RPC: `https://rpc.magicblock.app/mainnet` or a paid provider):
   `solana program deploy target/deploy/mempire-mainnet.so --program-id target/deploy/mempire-keypair.json`
   — same for `mempire_rollup-mainnet.so`; AMM now or later.
3. **Mint $MEMPIRE** with `chain/.mempire-mint-mainnet.json` (6 decimals),
   set Metaplex metadata, mint initial supply to the treasury, then decide
   the mint authority (null = fixed supply, or the multisig).
4. **init_config** with mainnet economics — the program now enforces sane
   ranges: `unstake_cooldown_secs = 259200` (72h), `match_timeout_secs =
   86400` (24h), `rake_bps = 1000`, `tie_rake_bps = 500`,
   `unstake_fee_bps = 200`, `mint_fee_lamports` = launch price,
   treasury = the multisig from step 1.
5. **Register the 36 coins** from `server/mainnet-coins.json` (adapting
   `chain/scripts/seed-devnet.ts`'s registration loop — prices/liquidity now
   come from the registry file, which came from live markets, not from the
   fabricated table; refresh with `node chain/build-mainnet-registry.mjs`
   first).
6. **AMM pool** (if deploying now): open $MEMPIRE/USDC against **mainnet
   USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`**, write the new
   `amm.json` (cluster: mainnet-beta) into `app/src/lib/` and `server/`.
7. **Relay** (Railway): set `SOLANA_RPC` to the mainnet RPC (this alone
   flips the registry, disables faucet route registration, and points
   chain verification at mainnet), `CORS_ORIGIN=https://play.mempire.fun`,
   rotate `MONGODB_URI` credentials. Do **not** set `FAUCET_SECRET`.
8. **App build**: `VITE_CLUSTER=mainnet-beta`, `VITE_RPC_URL=<mainnet rpc>`
   (must agree — the app refuses to boot confused), optional
   `VITE_PRIORITY_FEE` override. Build **after** steps 5–6 write the
   registry/amm files. Deploy to Vercel.
9. **Smoke suite** with two funded wallets at the smallest tier: mint,
   stake/unstake round trip (72h claim stays pending — verify the refusal),
   one staked PvP match settling via `SettleFromLog`, one chest through the
   real VRF queue, one swap if the pool exists.

## Programs: devnet vs mainnet drift

The two-claim chest settlement (`end_log`) and the VRF production-queue-only
gate redeployed to **devnet** and re-verified there. Two init-time
hardenings (config bounds, ticker charset) are compile-verified but not
redeployed on devnet — they change no live devnet behaviour (config is
already initialized; tickers there are registry-controlled) and deploy
fresh with mainnet. The devnet base program redeploys with them on the next
funded upgrade.

## Known-open, deliberately deferred (documented, not hidden)

- **Result-dispute griefing** (AUDIT.md C9): a loser can always claim the
  opposite result, void the match, and refund both stakes minus nothing.
  They cannot steal — only deny the winner the pot. Closing it needs
  on-chain replay of the play log against the deck commitment. Ship risk:
  griefers make ranked staking annoying, not lossy.
- **AMM `init_pool` is permissionless** — first-caller sets fee_bps for a
  mint pair. Launch mitigations: open the canonical pool in the same
  transaction batch as the AMM deploy.
- **One relay replica** — the matchmaker's queues are in-memory; a deploy
  drops live queues (not matches — those settle on chain). Fine at launch
  scale.
- **Unaudited programs.** Real audits cost more than this budget; the
  mitigations are the small pots (tiers cap exposure), the dispute-refund
  design (cheating voids rather than pays), and the kill switch of pausing
  the frontend. Do not raise tier caps until an audit happens.

## Security debts that predate mainnet (do these regardless)

- Revoke the GitHub PAT (github.com/settings/tokens) — still live.
- Revoke the Heroku API token (dashboard.heroku.com/account/applications).
- Rotate the MongoDB Atlas password (it sat in a pasted plaintext string).
- Back up `mobile/keys/mempire-release.keystore` and
  `chain/.mempire-mint-mainnet.json` somewhere that is not this SSD.
