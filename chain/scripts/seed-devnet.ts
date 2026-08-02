/**
 * Devnet seed: 12 SPL "meme coins", program config, and the mock oracle.
 * Two coins deliberately fail the eligibility gate (RUGPROOF: liquidity,
 * BBWHALE: age) so the demo shows the gate working.
 *
 * Run: npx tsx scripts/seed-devnet.ts
 * Writes: ../app/src/lib/devnet-coins.json (frontend swaps its mocks for this)
 */
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
} from '@solana/web3.js';
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
} from '@solana/spl-token';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const COINS = [
  { ticker: 'DOGGO', name: 'Doggo', hue: 38, priceUsd: 0.000082, liquidityUsd: 410_000, ageDays: 87 },
  { ticker: 'WIFHAT', name: 'Dog Wif Hat', hue: 320, priceUsd: 0.0021, liquidityUsd: 890_000, ageDays: 220 },
  { ticker: 'POPKAT', name: 'Popkat', hue: 265, priceUsd: 0.00034, liquidityUsd: 260_000, ageDays: 162 },
  { ticker: 'PENG', name: 'Peng', hue: 205, priceUsd: 0.00095, liquidityUsd: 175_000, ageDays: 58 },
  { ticker: 'FRG', name: 'Frog', hue: 130, priceUsd: 0.00012, liquidityUsd: 96_000, ageDays: 325 },
  { ticker: 'MOONCAT', name: 'Mooncat', hue: 52, priceUsd: 0.00048, liquidityUsd: 71_000, ageDays: 37 },
  { ticker: 'RKT', name: 'Rocket', hue: 12, priceUsd: 0.0013, liquidityUsd: 154_000, ageDays: 108 },
  { ticker: 'CHAD', name: 'Chad', hue: 350, priceUsd: 0.0044, liquidityUsd: 330_000, ageDays: 196 },
  { ticker: 'GMI', name: 'Gonna Make It', hue: 88, priceUsd: 0.00019, liquidityUsd: 59_000, ageDays: 79 },
  { ticker: 'SER', name: 'Ser', hue: 228, priceUsd: 0.00061, liquidityUsd: 88_000, ageDays: 129 },
  // the gate at work:
  { ticker: 'BBWHALE', name: 'Baby Whale', hue: 190, priceUsd: 0.0008, liquidityUsd: 140_000, ageDays: 0 },
  { ticker: 'RUGPROOF', name: 'Rugproof', hue: 28, priceUsd: 0.000031, liquidityUsd: 8_200, ageDays: 216 },
];

const DECIMALS = 6;
const SUPPLY_TO_ADMIN = 10_000_000_000n * 10n ** BigInt(DECIMALS); // 10B tokens

/**
 * Whichever keypair the CLI is actually configured with — hardcoding id.json
 * meant this script signed as an account that may not exist, let alone be funded.
 * ANCHOR_WALLET wins so CI can point it anywhere.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Four transactions per coin on a shared public RPC. Patience beats a 429. */
const SEED_DELAY_MS = Number(process.env.SEED_DELAY_MS ?? 6000);

/** Reads a previous partial seed so a rate-limited run can be resumed. */
function readSeed(path: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed.coins) ? parsed.coins : [];
  } catch { return []; }
}

/** 429 is the expected failure here, not an exceptional one. Back off and retry. */
async function withRetry(label: string, fn: () => Promise<void>, attempts = 5): Promise<void> {
  for (let i = 1; i <= attempts; i += 1) {
    try { await fn(); return; } catch (e) {
      const msg = (e as Error).message ?? '';
      if (i === attempts || !/429|Too many requests|timed out|blockhash/i.test(msg)) throw e;
      const wait = 3000 * i;
      console.warn(`${label}: ${msg.slice(0, 60)} — retry ${i}/${attempts - 1} in ${wait}ms`);
      await sleep(wait);
    }
  }
}

function adminKeypairPath(): string {
  if (process.env.ANCHOR_WALLET) return process.env.ANCHOR_WALLET;
  const cfg = join(homedir(), '.config/solana/cli/config.yml');
  try {
    const m = readFileSync(cfg, 'utf8').match(/keypair_path:\s*(.+)/);
    if (m) return m[1].trim().replace(/^~/, homedir());
  } catch { /* fall through to the default below */ }
  return join(homedir(), '.config/solana/id.json');
}

async function main() {
  const rpc = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
  // The public devnet RPC 429s on the websocket subscription that
  // confirmTransaction opens, and that rejection arrives outside the awaited
  // call — so it killed the process even though the retry wrapper was in place.
  // Long polling timeout + a top-level guard keeps a stray one from ending the run.
  const connection = new Connection(rpc, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 120_000,
  });
  process.on('unhandledRejection', (e) => {
    console.warn('ignored stray rejection:', String((e as Error)?.message ?? e).slice(0, 70));
  });
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(adminKeypairPath(), 'utf8'))));
  console.log('admin:', admin.publicKey.toBase58());

  const balance = await connection.getBalance(admin.publicKey);
  console.log('balance:', balance / LAMPORTS_PER_SOL, 'SOL');
  if (balance < 0.5 * LAMPORTS_PER_SOL) {
    console.log('low balance — requesting airdrop…');
    try {
      const sig = await connection.requestAirdrop(admin.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
    } catch (e) {
      console.warn('airdrop failed (rate limit?) — continuing:', (e as Error).message);
    }
  }

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
    commitment: 'confirmed',
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(readFileSync(join(__dirname, '../target/idl/mempire.json'), 'utf8'));
  const program = new Program(idl, provider);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('config')], program.programId,
  );

  // 1. init config (idempotent-ish: skip if exists)
  const existing = await connection.getAccountInfo(configPda);
  if (!existing) {
    await program.methods
      .initConfig(
        new anchor.BN(0.02 * LAMPORTS_PER_SOL), // mint fee
        1000, // rake 10%
        500, // tie rake 5%
        200, // unstake fee 2%
        new anchor.BN(60), // unstake cooldown: 60s on devnet (72h mainnet)
        new anchor.BN(300), // match timeout 5 min
        new anchor.BN(48 * 3600), // min coin age 48h
        12, // power band
      )
      .accounts({
        admin: admin.publicKey,
        treasury: admin.publicKey, // devnet: admin doubles as treasury
      })
      .rpc();
    console.log('config initialized:', configPda.toBase58());
  } else {
    console.log('config exists:', configPda.toBase58());
  }

  // 2. mints + registration.
  // The public devnet RPC rate-limits hard (429) partway through twelve coins,
  // so this resumes from whatever the last run already wrote and flushes after
  // every coin. Re-running until it prints "seed complete" is the intended flow.
  const outPath = join(__dirname, '../../app/src/lib/devnet-coins.json');
  const prior = readSeed(outPath);
  const done = new Map(prior.map((c) => [c.ticker as string, c]));
  const now = Math.floor(Date.now() / 1000);

  const flush = (coins: Record<string, unknown>[]) => {
    writeFileSync(outPath, `${JSON.stringify({
      cluster: 'devnet',
      programId: program.programId.toBase58(),
      config: configPda.toBase58(),
      admin: admin.publicKey.toBase58(),
      seededAt: now,
      coins,
    }, null, 2)}\n`);
  };

  for (const c of COINS) {
    if (done.has(c.ticker)) { console.log(`${c.ticker.padEnd(9)} (already seeded)`); continue; }

    const firstSeen = now - c.ageDays * 86_400;
    const priceMicro = Math.round(c.priceUsd * 1_000_000);
    await withRetry(c.ticker, async () => {
      const mint = await createMint(connection, admin, admin.publicKey, null, DECIMALS);
      const ata = await getOrCreateAssociatedTokenAccount(connection, admin, mint, admin.publicKey);
      await mintTo(connection, admin, mint, ata.address, admin, SUPPLY_TO_ADMIN);
      await program.methods
        .registerCoin(
          new anchor.BN(c.liquidityUsd),
          new anchor.BN(priceMicro),
          new anchor.BN(firstSeen),
        )
        .accounts({ mint, admin: admin.publicKey })
        .rpc();

      console.log(`${c.ticker.padEnd(9)} ${mint.toBase58()}`);
      done.set(c.ticker, {
        mint: mint.toBase58(),
        ticker: c.ticker,
        name: c.name,
        hue: c.hue,
        priceUsd: c.priceUsd,
        liquidityUsd: c.liquidityUsd,
        firstSeen,
        decimals: DECIMALS,
      });
      // ordered by COINS so the file is stable across resumes
      flush(COINS.map((k) => done.get(k.ticker)).filter(Boolean) as Record<string, unknown>[]);
    });
    await sleep(SEED_DELAY_MS); // stay under the public RPC's per-call ceiling
  }

  flush(COINS.map((k) => done.get(k.ticker)).filter(Boolean) as Record<string, unknown>[]);
  console.log(`\nwrote ${outPath}`);
  console.log(done.size === COINS.length
    ? 'seed complete.'
    : `seed partial: ${done.size}/${COINS.length} — re-run to continue.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
