/**
 * What the last few matches look like on chain, right now.
 *
 * Written for the two-browser run: when the UI claims a pot is live, this is
 * how you check that claim against the ledger rather than against the UI's own
 * word for it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const STATE = ['Open', 'Active', 'Settled'];

async function main() {
  const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
  const path = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)![1].trim();
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, 'utf8'))));
  const idl = JSON.parse(readFileSync('target/idl/mempire.json', 'utf8'));
  const program = new anchor.Program(
    idl,
    new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }),
  );

  const all: any[] = await (program.account as any).matchAccount.all();
  const recent = all
    .sort((a, b) => Number(b.account.id) - Number(a.account.id))
    .slice(0, 5);

  for (const m of recent) {
    const bal = await conn.getBalance(m.publicKey);
    const stake = Number(m.account.stakeLamports) / LAMPORTS_PER_SOL;
    const state = String(STATE[m.account.state] ?? m.account.state).padEnd(8);
    console.log(
      `#${m.account.id} ${state}stake ${stake.toFixed(3)}  `
      + `held ${(bal / LAMPORTS_PER_SOL).toFixed(4)}  winner ${m.account.winner}`,
    );
    console.log(
      `        A ${m.account.players[0].toBase58().slice(0, 12)}…`
      + `  B ${m.account.players[1].toBase58().slice(0, 12)}…`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
