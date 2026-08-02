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

/**
 * Every asset in `app/src/data/cards.json`, so the registry and the art set can never
 * disagree about what exists. Economics are plausible placeholders — the mock
 * oracle owns price on devnet — except the two deliberately gated coins below,
 * which exist to prove the eligibility gate rejects them.
 */
const COINS = [
  { ticker: 'BTC', name: 'Bitcoin', hue: 38, priceUsd: 0.5, liquidityUsd: 900000, ageDays: 400, kind: 'crypto' },
  { ticker: 'ETH', name: 'Ethereum', hue: 320, priceUsd: 11.8, liquidityUsd: 1110000, ageDays: 403, kind: 'crypto' },
  { ticker: 'SOL', name: 'Solana', hue: 265, priceUsd: 23.1, liquidityUsd: 1320000, ageDays: 406, kind: 'crypto' },
  { ticker: 'BNB', name: 'BNB', hue: 205, priceUsd: 34.4, liquidityUsd: 1530000, ageDays: 409, kind: 'crypto' },
  { ticker: 'XRP', name: 'XRP', hue: 130, priceUsd: 45.7, liquidityUsd: 1740000, ageDays: 412, kind: 'crypto' },
  { ticker: 'ADA', name: 'Cardano', hue: 52, priceUsd: 57.0, liquidityUsd: 1950000, ageDays: 415, kind: 'crypto' },
  { ticker: 'DOGE', name: 'Dogecoin', hue: 12, priceUsd: 68.3, liquidityUsd: 2160000, ageDays: 418, kind: 'crypto' },
  { ticker: 'AVAX', name: 'Avalanche', hue: 350, priceUsd: 79.6, liquidityUsd: 900000, ageDays: 421, kind: 'crypto' },
  { ticker: 'LINK', name: 'Chainlink', hue: 88, priceUsd: 90.9, liquidityUsd: 1110000, ageDays: 424, kind: 'crypto' },
  { ticker: 'DOT', name: 'Polkadot', hue: 228, priceUsd: 0.5, liquidityUsd: 1320000, ageDays: 427, kind: 'crypto' },
  { ticker: 'MATIC', name: 'Polygon', hue: 190, priceUsd: 11.8, liquidityUsd: 1530000, ageDays: 430, kind: 'crypto' },
  { ticker: 'TRX', name: 'TRON', hue: 28, priceUsd: 23.1, liquidityUsd: 1740000, ageDays: 433, kind: 'crypto' },
  { ticker: 'LTC', name: 'Litecoin', hue: 165, priceUsd: 34.4, liquidityUsd: 1950000, ageDays: 436, kind: 'crypto' },
  { ticker: 'SHIB', name: 'Shiba Inu', hue: 300, priceUsd: 45.7, liquidityUsd: 2160000, ageDays: 439, kind: 'crypto' },
  { ticker: 'UNI', name: 'Uniswap', hue: 15, priceUsd: 57.0, liquidityUsd: 900000, ageDays: 442, kind: 'crypto' },
  { ticker: 'ATOM', name: 'Cosmos', hue: 72, priceUsd: 68.3, liquidityUsd: 1110000, ageDays: 445, kind: 'crypto' },
  { ticker: 'XLM', name: 'Stellar', hue: 255, priceUsd: 79.6, liquidityUsd: 1320000, ageDays: 448, kind: 'crypto' },
  { ticker: 'APT', name: 'Aptos', hue: 110, priceUsd: 90.9, liquidityUsd: 1530000, ageDays: 451, kind: 'crypto' },
  { ticker: 'ARB', name: 'Arbitrum', hue: 340, priceUsd: 0.5, liquidityUsd: 1740000, ageDays: 454, kind: 'crypto' },
  { ticker: 'OP', name: 'Optimism', hue: 200, priceUsd: 11.8, liquidityUsd: 1950000, ageDays: 457, kind: 'crypto' },
  { ticker: 'AAPL', name: 'Apple', hue: 38, priceUsd: 181.5, liquidityUsd: 1020000, ageDays: 540, kind: 'stock' },
  { ticker: 'TSLA', name: 'Tesla', hue: 320, priceUsd: 199.0, liquidityUsd: 1180000, ageDays: 542, kind: 'stock' },
  { ticker: 'NVDA', name: 'Nvidia', hue: 265, priceUsd: 24.0, liquidityUsd: 1340000, ageDays: 544, kind: 'stock' },
  { ticker: 'MSFT', name: 'Microsoft', hue: 205, priceUsd: 41.5, liquidityUsd: 1500000, ageDays: 546, kind: 'stock' },
  { ticker: 'GOOGL', name: 'Alphabet', hue: 130, priceUsd: 59.0, liquidityUsd: 700000, ageDays: 548, kind: 'stock' },
  { ticker: 'AMZN', name: 'Amazon', hue: 52, priceUsd: 76.5, liquidityUsd: 860000, ageDays: 550, kind: 'stock' },
  { ticker: 'META', name: 'Meta', hue: 12, priceUsd: 94.0, liquidityUsd: 1020000, ageDays: 552, kind: 'stock' },
  { ticker: 'NFLX', name: 'Netflix', hue: 350, priceUsd: 111.5, liquidityUsd: 1180000, ageDays: 554, kind: 'stock' },
  { ticker: 'AMD', name: 'AMD', hue: 88, priceUsd: 129.0, liquidityUsd: 1340000, ageDays: 556, kind: 'stock' },
  { ticker: 'INTC', name: 'Intel', hue: 228, priceUsd: 146.5, liquidityUsd: 1500000, ageDays: 558, kind: 'stock' },
  { ticker: 'COIN', name: 'Coinbase', hue: 190, priceUsd: 164.0, liquidityUsd: 700000, ageDays: 560, kind: 'stock' },
  { ticker: 'HOOD', name: 'Robinhood', hue: 28, priceUsd: 181.5, liquidityUsd: 860000, ageDays: 562, kind: 'stock' },
  { ticker: 'MSTR', name: 'MicroStrategy', hue: 165, priceUsd: 199.0, liquidityUsd: 1020000, ageDays: 564, kind: 'stock' },
  { ticker: 'SPY', name: 'S and P 500', hue: 300, priceUsd: 24.0, liquidityUsd: 1180000, ageDays: 566, kind: 'stock' },
  { ticker: 'QQQ', name: 'Nasdaq 100', hue: 15, priceUsd: 41.5, liquidityUsd: 1340000, ageDays: 568, kind: 'stock' },
  { ticker: 'DIS', name: 'Disney', hue: 72, priceUsd: 59.0, liquidityUsd: 1500000, ageDays: 570, kind: 'stock' },
  { ticker: 'JPM', name: 'JPMorgan', hue: 255, priceUsd: 76.5, liquidityUsd: 700000, ageDays: 572, kind: 'stock' },
  { ticker: 'V', name: 'Visa', hue: 110, priceUsd: 94.0, liquidityUsd: 860000, ageDays: 574, kind: 'stock' },
  { ticker: 'PLTR', name: 'Palantir', hue: 340, priceUsd: 111.5, liquidityUsd: 1020000, ageDays: 576, kind: 'stock' },
  { ticker: 'SBUX', name: 'Starbucks', hue: 200, priceUsd: 129.0, liquidityUsd: 1180000, ageDays: 578, kind: 'stock' },
  { ticker: 'BONK', name: 'Bonk', hue: 38, priceUsd: 0.00025, liquidityUsd: 440000, ageDays: 220, kind: 'meme' },
  { ticker: 'WIF', name: 'dogwifhat', hue: 320, priceUsd: 0.00046, liquidityUsd: 535000, ageDays: 224, kind: 'meme' },
  { ticker: 'POPCAT', name: 'Popcat', hue: 265, priceUsd: 0.00067, liquidityUsd: 630000, ageDays: 228, kind: 'meme' },
  { ticker: 'PNUT', name: 'Peanut the Squirrel', hue: 205, priceUsd: 0.00088, liquidityUsd: 725000, ageDays: 232, kind: 'meme' },
  { ticker: 'FWOG', name: 'Fwog', hue: 130, priceUsd: 0.00109, liquidityUsd: 820000, ageDays: 236, kind: 'meme' },
  { ticker: 'GOAT', name: 'Goatseus Maximus', hue: 52, priceUsd: 0.0013, liquidityUsd: 60000, ageDays: 240, kind: 'meme' },
  { ticker: 'CHILLGUY', name: 'Chill Guy', hue: 12, priceUsd: 0.00151, liquidityUsd: 155000, ageDays: 244, kind: 'meme' },
  { ticker: 'MOODENG', name: 'Moo Deng', hue: 350, priceUsd: 0.00172, liquidityUsd: 250000, ageDays: 248, kind: 'meme' },
  { ticker: 'AI16Z', name: 'ai16z', hue: 88, priceUsd: 0.00193, liquidityUsd: 345000, ageDays: 252, kind: 'meme' },
  { ticker: 'TRUMPC', name: 'Trump Coin', hue: 228, priceUsd: 0.00214, liquidityUsd: 440000, ageDays: 256, kind: 'meme' },
  { ticker: 'MEW', name: 'cat in a dogs world', hue: 190, priceUsd: 0.00235, liquidityUsd: 535000, ageDays: 260, kind: 'meme' },
  { ticker: 'CATS', name: 'Cats', hue: 28, priceUsd: 0.00256, liquidityUsd: 630000, ageDays: 264, kind: 'meme' },
  { ticker: 'PEPE', name: 'Pepe', hue: 165, priceUsd: 4e-05, liquidityUsd: 725000, ageDays: 268, kind: 'meme' },
  { ticker: 'BRETT', name: 'Brett', hue: 300, priceUsd: 0.00025, liquidityUsd: 820000, ageDays: 272, kind: 'meme' },
  { ticker: 'MOG', name: 'Mog', hue: 15, priceUsd: 0.00046, liquidityUsd: 60000, ageDays: 276, kind: 'meme' },
  { ticker: 'PONKE', name: 'Ponke', hue: 72, priceUsd: 0.00067, liquidityUsd: 155000, ageDays: 280, kind: 'meme' },
  { ticker: 'MICHI', name: 'Michi', hue: 255, priceUsd: 0.00088, liquidityUsd: 250000, ageDays: 284, kind: 'meme' },
  { ticker: 'GIGA', name: 'Gigachad', hue: 110, priceUsd: 0.00109, liquidityUsd: 345000, ageDays: 288, kind: 'meme' },
  { ticker: 'RETARDIO', name: 'Retardio', hue: 340, priceUsd: 0.0013, liquidityUsd: 440000, ageDays: 292, kind: 'meme' },
  { ticker: 'SLERF', name: 'Slerf', hue: 200, priceUsd: 0.00151, liquidityUsd: 535000, ageDays: 296, kind: 'meme' },
  { ticker: 'BOME', name: 'Book of Meme', hue: 38, priceUsd: 0.00172, liquidityUsd: 630000, ageDays: 300, kind: 'meme' },
  { ticker: 'SILLY', name: 'Silly Dragon', hue: 320, priceUsd: 0.00193, liquidityUsd: 725000, ageDays: 304, kind: 'meme' },
  { ticker: 'HARAMBE', name: 'Harambe', hue: 265, priceUsd: 0.00214, liquidityUsd: 820000, ageDays: 308, kind: 'meme' },
  { ticker: 'WEN', name: 'Wen', hue: 205, priceUsd: 0.00235, liquidityUsd: 60000, ageDays: 312, kind: 'meme' },
  // the gate at work: one too illiquid, one too young
  { ticker: 'BBWHALE', name: 'Baby Whale', hue: 190, priceUsd: 0.0008, liquidityUsd: 140_000, ageDays: -3650, kind: 'meme' },
  { ticker: 'RUGPROOF', name: 'Rugproof', hue: 28, priceUsd: 0.000031, liquidityUsd: 8_200, ageDays: 216, kind: 'meme' },
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

    // A negative `ageDays` puts `first_seen` in the future, which makes the
    // coin permanently "younger than 48h" and therefore permanently gated.
    //
    // That is deliberate, and it fixes a live time bomb. BBWHALE exists to
    // demonstrate the age gate and was seeded at `ageDays: 0` — genuinely zero
    // hours old at seed time, correctly refused. Forty-eight hours later it
    // aged past the gate and started minting, so the demo silently stopped
    // demonstrating anything. `register_coin` uses `init` and `set_price` does
    // not touch `first_seen`, so there is no way to refresh it in place; the
    // fixture has to be one that never expires. This is the devnet mock oracle,
    // which Jupiter/Pyth replaces on mainnet, so a fixture that is honestly a
    // fixture is the right answer.
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
  // Count what is actually in the registry, not the resume map: the map also
  // holds tickers from earlier runs that are no longer in COINS, which made a
  // finished seed report itself as "76/66 partial".
  const written = COINS.filter((k) => done.has(k.ticker)).length;
  console.log(written === COINS.length
    ? `seed complete — ${written} assets.`
    : `seed partial: ${written}/${COINS.length} — re-run to continue.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
