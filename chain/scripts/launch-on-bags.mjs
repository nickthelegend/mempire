#!/usr/bin/env node
/**
 * Launch $MEMPIRE on Bags, and hand the mint straight to the step that needs it.
 *
 * # Why a script rather than the website
 *
 * The program bakes `MEMPIRE_MINT` in at compile time, so launch day has an
 * ordering problem: the token must exist before the binary is built, and the
 * address it returns has to reach `bake-mainnet-mint.mjs` without a human
 * retyping a base58 string between two irreversible, money-spending steps.
 * Doing it here means the address is printed, verified, and ready to bake in one
 * place — and the whole sequence is reviewable before it is run.
 *
 * # What it does not do
 *
 * It does not sign or send anything by default. `--dry-run` (the default) shows
 * exactly what would happen and stops. Sending requires `--confirm` *and* a
 * keypair path, because this spends real SOL and creates a token that cannot be
 * un-created.
 *
 * # Use
 *
 *     BAGS_API_KEY=… node scripts/launch-on-bags.mjs            # plan only
 *     BAGS_API_KEY=… node scripts/launch-on-bags.mjs \
 *       --confirm --keypair ~/.config/solana/id.json --initial-buy 0.05
 *
 * The fee-share config is where the creator's cut is decided. By default the
 * whole 100% goes to the launching wallet; `--treasury <pubkey> --treasury-bps
 * <n>` splits it, which is how the game's own treasury can be a fee claimer
 * rather than a separate manual transfer later.
 */
import fs from 'node:fs';

const API = process.env.BAGS_API ?? 'https://public-api-v2.bags.fm/api/v1';
const KEY = process.env.BAGS_API_KEY ?? '';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const CONFIRM = has('confirm');
const KEYPAIR = flag('keypair');
const INITIAL_BUY_SOL = Number(flag('initial-buy', '0'));
const TREASURY = flag('treasury');
const TREASURY_BPS = Number(flag('treasury-bps', '0'));

const NAME = flag('name', 'Mempire');
const SYMBOL = flag('symbol', 'MEMPIRE');
const DESCRIPTION = flag(
  'description',
  'Every coin is a fighter. A real-time card battler on Solana where the roster is the market itself.',
);
const IMAGE = flag('image', 'https://play.mempire.fun/art/logo.webp');
const WEBSITE = flag('website', 'https://mempire.fun');

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

async function bags(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'x-api-key': KEY, accept: 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error ?? body?.message ?? `bags ${res.status}`;
    throw new Error(`${String(msg).slice(0, 200)} (${path})`);
  }
  return body?.response ?? body;
}

if (!KEY) die('BAGS_API_KEY is not set. Get one from dev.bags.fm.');

/*
 * Fee claimers must sum to 10,000 bps, and the launching wallet has to appear
 * explicitly — omitting yourself is a silent way to give the whole cut away.
 */
let launcher = null;
if (KEYPAIR) {
  const raw = JSON.parse(fs.readFileSync(String(KEYPAIR).replace('~', process.env.HOME), 'utf8'));
  const { Keypair } = await import('@solana/web3.js');
  launcher = Keypair.fromSecretKey(Uint8Array.from(raw));
}

const claimers = [];
if (TREASURY && TREASURY_BPS > 0) {
  if (TREASURY_BPS >= 10_000) die('--treasury-bps must leave something for the launcher');
  claimers.push({ wallet: String(TREASURY), bps: TREASURY_BPS });
}
if (launcher) {
  claimers.push({
    wallet: launcher.publicKey.toBase58(),
    bps: 10_000 - claimers.reduce((n, c) => n + c.bps, 0),
  });
}

console.log('\n  Launching $MEMPIRE on Bags\n');
console.log(`    name         ${NAME} (${SYMBOL})`);
console.log(`    image        ${IMAGE}`);
console.log(`    website      ${WEBSITE}`);
console.log(`    initial buy  ${INITIAL_BUY_SOL} SOL`);
console.log(`    launcher     ${launcher ? launcher.publicKey.toBase58() : '(no --keypair given)'}`);
console.log('    fee split    '
  + (claimers.length
    ? claimers.map((c) => `${c.wallet.slice(0, 8)}… ${(c.bps / 100).toFixed(1)}%`).join(' · ')
    : '(needs --keypair)'));

if (!CONFIRM) {
  console.log('\n  Dry run — nothing sent. Re-run with --confirm and --keypair to launch.\n');
  console.log('  After launching, bake the mint it prints:');
  console.log('    node scripts/bake-mainnet-mint.mjs <mint>\n');
  process.exit(0);
}
if (!launcher) die('--confirm needs --keypair: something has to sign and pay.');

// ── 1. metadata ─────────────────────────────────────────────────────────────
console.log('\n  1/3  uploading metadata…');
const info = await bags('/token-launch/create-token-info', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: NAME,
    symbol: SYMBOL,
    description: DESCRIPTION,
    image: IMAGE,
    website: WEBSITE,
  }),
});
const mint = info?.tokenMint ?? info?.mint;
const metadataUrl = info?.tokenMetadata ?? info?.metadataUrl;
if (!mint) die(`no mint in the metadata response: ${JSON.stringify(info).slice(0, 200)}`);
console.log(`       mint     ${mint}`);

// ── 2. fee share ────────────────────────────────────────────────────────────
console.log('  2/3  creating the fee-share config…');
const cfg = await bags('/fee-share/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ feeClaimers: claimers, quoteMint: 'So11111111111111111111111111111111111111112' }),
});
const configKey = cfg?.meteoraConfigKey ?? cfg?.configKey;
if (!configKey) die(`no config key returned: ${JSON.stringify(cfg).slice(0, 200)}`);

// ── 3. launch ───────────────────────────────────────────────────────────────
console.log('  3/3  building the launch transaction…');
const launch = await bags('/token-launch/create-launch-transaction', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    tokenMint: mint,
    metadataUrl,
    configKey,
    initialBuyLamports: Math.round(INITIAL_BUY_SOL * 1e9),
    wallet: launcher.publicKey.toBase58(),
  }),
});

const { Connection, VersionedTransaction } = await import('@solana/web3.js');
const conn = new Connection(process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com', 'confirmed');
const raw = launch?.transaction ?? launch;
const tx = VersionedTransaction.deserialize(Buffer.from(String(raw), 'base64'));
tx.sign([launcher]);
const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
await conn.confirmTransaction(sig, 'confirmed');

console.log(`\n  launched — ${sig}\n`);
console.log(`  $MEMPIRE mint: ${mint}\n`);
console.log('  Next, in order:');
console.log(`    node scripts/bake-mainnet-mint.mjs ${mint}`);
console.log('    anchor build -p mempire -- --no-default-features --features mainnet,rollup');
console.log('    solana program deploy …\n');
console.log('  And set on the relay:  BAGS_API_KEY=…  MEMPIRE_MINT=' + mint + '\n');
