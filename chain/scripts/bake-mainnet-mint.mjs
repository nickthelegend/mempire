#!/usr/bin/env node
/**
 * Bake a mint address into the program's `mainnet` build.
 *
 * # Why this exists
 *
 * `MEMPIRE_MINT` is a compile-time constant, so the token has to exist *before*
 * the program is built. If $MEMPIRE launches on Bags, Bags creates the mint and
 * returns an address nobody can predict — which means launch day otherwise
 * involves hand-editing Rust between two irreversible, money-spending steps.
 * That is exactly where a typo costs a second 4.17 SOL deploy.
 *
 * So: this script does the edit, validates the address is a real mint that
 * actually exists on mainnet, and refuses rather than guessing.
 *
 * # Use
 *
 *     node scripts/bake-mainnet-mint.mjs <mint-address>
 *     node scripts/bake-mainnet-mint.mjs <mint-address> --rpc https://…
 *     node scripts/bake-mainnet-mint.mjs --check          # what is baked now?
 *
 * Then build and deploy as MAINNET.md describes. The devnet constant is never
 * touched — this only rewrites the one behind `#[cfg(feature = "mainnet")]`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'programs', 'mempire', 'src', 'lib.rs');

/** The mainnet constant, and only that one — the devnet line above it matches
 *  the same shape, so the cfg attribute is part of the pattern on purpose. */
const MAINNET_CONST =
  /(#\[cfg\(feature = "mainnet"\)\]\s*\nconst MEMPIRE_MINT: Pubkey = pubkey!\(")([1-9A-HJ-NP-Za-km-z]{32,44})("\);)/;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function currentlyBaked() {
  const m = MAINNET_CONST.exec(readFileSync(LIB, 'utf8'));
  if (!m) throw new Error(`could not find the mainnet MEMPIRE_MINT constant in ${LIB}`);
  return m[2];
}

/**
 * Confirm the address is a mint that exists, because the failure mode of a
 * wrong-but-well-formed address is silent: the program deploys fine and then
 * every $MEMPIRE constraint refuses, after the SOL is spent.
 */
async function assertIsMainnetMint(mint, rpc) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [mint, { encoding: 'jsonParsed' }],
    }),
  });
  const body = await res.json();
  const value = body?.result?.value;
  if (!value) throw new Error(`${mint} does not exist on ${rpc} — is it launched yet?`);

  const owner = value.owner;
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  if (owner !== TOKEN && owner !== TOKEN22) {
    throw new Error(`${mint} is owned by ${owner}, which is not a token program — that is not a mint`);
  }
  const parsed = value.data?.parsed;
  if (parsed?.type !== 'mint') throw new Error(`${mint} is a token account, not a mint`);

  const decimals = parsed.info?.decimals;
  if (decimals !== 6) {
    // Not fatal to the build, but every amount constant in the program assumes
    // 6 — UPGRADE_BASE_FEE, WIN_REWARD, the shop prices. Say so loudly.
    console.warn(`  ⚠ decimals is ${decimals}, not 6 — every $MEMPIRE amount constant`);
    console.warn(`    in lib.rs assumes 6 and will be off by 10^${Math.abs(6 - decimals)}.`);
  }
  return { decimals, supply: parsed.info?.supply, owner };
}

const args = process.argv.slice(2);
const rpcAt = args.indexOf('--rpc');
const rpc = rpcAt >= 0 ? args[rpcAt + 1] : 'https://api.mainnet-beta.solana.com';
// `rpcAt + 1` is only the rpc *value* when --rpc was actually passed; with
// rpcAt at -1 that expression is 0, which silently eats the first argument.
const rpcValueAt = rpcAt >= 0 ? rpcAt + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== rpcValueAt);

if (args.includes('--check') || positional.length === 0) {
  const baked = currentlyBaked();
  console.log(`mainnet MEMPIRE_MINT is currently: ${baked}`);

  if (args.includes('--check')) {
    // The whole point of a pre-flight: a well-formed address that is not a live
    // mint deploys perfectly and then refuses every $MEMPIRE instruction, after
    // the SOL is spent. Say so before that happens, not after.
    const info = await assertIsMainnetMint(baked, rpc).catch((e) => {
      console.error(`\n  ✗ NOT SAFE TO DEPLOY: ${e.message}`);
      console.error('    Launch the token first, then bake the address it returns.');
      process.exit(1);
    });
    console.log(`  ✓ live on mainnet · decimals ${info.decimals} · supply ${info.supply}`);
    process.exit(0);
  }

  console.log('\nusage: node scripts/bake-mainnet-mint.mjs <mint-address>');
  process.exit(1);
}

const mint = positional[0];
if (!BASE58.test(mint)) {
  console.error(`✗ "${mint}" is not a base58 address`);
  process.exit(1);
}

const was = currentlyBaked();
if (was === mint) {
  console.log(`already baked: ${mint} — nothing to do`);
  process.exit(0);
}

console.log(`checking ${mint} on ${rpc}…`);
const info = await assertIsMainnetMint(mint, rpc).catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
console.log(`  ✓ real mint · decimals ${info.decimals} · supply ${info.supply}`);

const src = readFileSync(LIB, 'utf8');
writeFileSync(LIB, src.replace(MAINNET_CONST, `$1${mint}$3`));

// Read it back rather than trusting the write — this is the one edit where
// being wrong is expensive.
const now = currentlyBaked();
if (now !== mint) {
  console.error(`✗ wrote ${mint} but the file reads back ${now}`);
  process.exit(1);
}

console.log(`\n  ${was}\n→ ${mint}\n`);
console.log('baked. next:');
console.log('  anchor build -p mempire -- --no-default-features --features mainnet,rollup');
console.log('  solana program deploy target/deploy/mempire.so \\');
console.log('    --program-id target/deploy/mempire-keypair.json --url <mainnet rpc>');
