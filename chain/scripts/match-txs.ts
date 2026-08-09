/**
 * Every transaction that touched a given match, newest last.
 *
 * The demo shows one specific match; the explorer cutaway should show *that*
 * match's transactions rather than a generic example, because "here is the
 * match you just watched, on chain" is a much stronger claim than "here is a
 * delegation we did once".
 */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const MATCH_ID = Number(process.argv[2] ?? 61);
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(
    execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)![1].trim(), 'utf8'))));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' });
  const idl = JSON.parse(readFileSync('target/idl/mempire.json', 'utf8'));
  const prog = new anchor.Program(idl, provider);
  const pid = prog.programId;
  const u64 = new anchor.BN(MATCH_ID).toArrayLike(Buffer, 'le', 8);
  const matchPda = PublicKey.findProgramAddressSync([Buffer.from('match'), u64], pid)[0];
  const logPda = PublicKey.findProgramAddressSync([Buffer.from('log'), u64], pid)[0];

  for (const [name, pda] of [['match', matchPda], ['log', logPda]] as const) {
    const sigs = await conn.getSignaturesForAddress(pda as PublicKey, { limit: 20 });
    console.log(`\n${name} ${(pda as PublicKey).toBase58()}  (${sigs.length} txs)`);
    for (const s of sigs.reverse()) {
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      const ins = (tx?.meta?.logMessages ?? [])
        .filter((l) => l.includes('Instruction:'))
        .map((l) => l.split('Instruction: ')[1]);
      console.log(`  ${s.signature}`);
      console.log(`     ${ins.join(', ') || '(cpi only)'}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
