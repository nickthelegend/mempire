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

async function main() {
  const rpc = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpc, 'confirmed');
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(join(homedir(), '.config/solana/id.json'), 'utf8'))),
  );
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

  // 2. mints + registration
  const out: Record<string, unknown>[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const c of COINS) {
    const mint = await createMint(connection, admin, admin.publicKey, null, DECIMALS);
    const ata = await getOrCreateAssociatedTokenAccount(connection, admin, mint, admin.publicKey);
    await mintTo(connection, admin, mint, ata.address, admin, SUPPLY_TO_ADMIN);

    const firstSeen = now - c.ageDays * 86_400;
    const priceMicro = Math.round(c.priceUsd * 1_000_000);
    await program.methods
      .registerCoin(
        new anchor.BN(c.liquidityUsd),
        new anchor.BN(priceMicro),
        new anchor.BN(firstSeen),
      )
      .accounts({ mint, admin: admin.publicKey })
      .rpc();

    console.log(`${c.ticker.padEnd(9)} ${mint.toBase58()}`);
    out.push({
      mint: mint.toBase58(),
      ticker: c.ticker,
      name: c.name,
      hue: c.hue,
      priceUsd: c.priceUsd,
      liquidityUsd: c.liquidityUsd,
      firstSeen,
      decimals: DECIMALS,
    });
  }

  const outPath = join(__dirname, '../../app/src/lib/devnet-coins.json');
  writeFileSync(outPath, JSON.stringify({
    cluster: 'devnet',
    programId: program.programId.toBase58(),
    config: configPda.toBase58(),
    admin: admin.publicKey.toBase58(),
    seededAt: now,
    coins: out,
  }, null, 2));
  console.log('\nwrote', outPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
