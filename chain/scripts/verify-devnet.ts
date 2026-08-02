/**
 * Reads the deployed program's live state and prints it.
 *
 * This is the answer to "is the onchain half real?" — it fetches Config and
 * every registered CoinInfo from devnet and shows the actual economic
 * parameters the program will enforce. Run it after a deploy or a seed.
 *
 * Run: npx tsx scripts/verify-devnet.ts
 */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function adminKeypairPath(): string {
  if (process.env.ANCHOR_WALLET) return process.env.ANCHOR_WALLET;
  try {
    const m = readFileSync(join(homedir(), '.config/solana/cli/config.yml'), 'utf8')
      .match(/keypair_path:\s*(.+)/);
    if (m) return m[1].trim().replace(/^~/, homedir());
  } catch { /* default below */ }
  return join(homedir(), '.config/solana/id.json');
}

async function main() {
  const rpc = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
  const conn = new Connection(rpc, { commitment: 'confirmed', confirmTransactionInitialTimeout: 120_000 });
  process.on('unhandledRejection', () => { /* public RPC websocket noise */ });

  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(adminKeypairPath(), 'utf8'))));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' });
  const idl = JSON.parse(readFileSync(join(__dirname, '../target/idl/mempire.json'), 'utf8'));
  const program = new anchor.Program(idl, provider);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const accounts = program.account as any;

  console.log('cluster:  ', rpc);
  console.log('program:  ', program.programId.toBase58());

  const [cfgPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);
  const cfg = await accounts.config.fetch(cfgPda);
  console.log('config:   ', cfgPda.toBase58());
  console.log('  admin        ', cfg.admin.toBase58());
  console.log('  treasury     ', cfg.treasury.toBase58());
  console.log('  mint fee     ', Number(cfg.mintFeeLamports) / 1e9, 'SOL');
  console.log('  rake         ', cfg.rakeBps / 100, '%  (tie', cfg.tieRakeBps / 100, '%)');
  console.log('  unstake fee  ', cfg.unstakeFeeBps / 100, '%  cooldown', cfg.unstakeCooldownSecs.toString(), 's');
  console.log('  min coin age ', Number(cfg.minAgeSecs) / 3600, 'h   power band ±', cfg.powerBand);
  console.log('  next card id ', cfg.nextCardId.toString(), '  next match id', cfg.nextMatchId.toString());

  const coins = await accounts.coinInfo.all();
  console.log(`\nregistered coins: ${coins.length}`);
  for (const c of coins) {
    const a = c.account;
    const ageH = Math.round((Date.now() / 1000 - Number(a.firstSeenTs)) / 3600);
    const eligible = Number(a.liquidityUsd) >= 25_000 && ageH >= 48;
    console.log(
      `  ${a.mint.toBase58()}  liq $${Number(a.liquidityUsd).toLocaleString().padStart(9)}`
      + `  age ${String(ageH).padStart(6)}h  ${eligible ? 'eligible' : 'GATED'}`,
    );
  }

  const cards = await accounts.card.all();
  console.log(`\nminted cards: ${cards.length}`);
  for (const c of cards.slice(0, 10)) {
    console.log(`  #${c.account.id} owner ${c.account.owner.toBase58().slice(0, 8)}…`
      + ` arch ${c.account.archetype} lvl ${c.account.level} staked $${Number(c.account.stakedMicroUsd) / 1e6}`);
  }

  const matches = await accounts.matchAccount.all();
  console.log(`\nmatches: ${matches.length}`);
  for (const m of matches.slice(0, 10)) {
    console.log(`  #${m.account.id} tier ${m.account.tier} stake ${Number(m.account.stakeLamports) / 1e9} SOL`
      + ` state ${m.account.state} winner ${m.account.winner}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
