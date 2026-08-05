/**
 * One-off: resize `Card` accounts written before `locked_by` replaced `in_match`.
 *
 * Scans this program's accounts by discriminator rather than through Anchor's
 * typed `.all()`, because the accounts that need migrating are exactly the ones
 * the typed reader cannot decode.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

const BASE = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';
const OLD_LEN = 8 + 108;
const NEW_LEN = 8 + 139;

async function main() {
  const conn = new Connection(BASE, 'confirmed');
  const keypairPath = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)![1].trim()
    ?? join(homedir(), '.config/solana/id.json');
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))));
  const idl = JSON.parse(readFileSync('target/idl/mempire.json', 'utf8'));
  const prog = new anchor.Program(idl,
    new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }));

  const disc = createHash('sha256').update('account:Card').digest().subarray(0, 8);
  const all = await conn.getProgramAccounts(prog.programId, {
    filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(disc) } }],
  });
  const stale = all.filter((a) => a.account.data.length === OLD_LEN);
  const fresh = all.filter((a) => a.account.data.length >= NEW_LEN);
  console.log(`${all.length} cards · ${stale.length} stale · ${fresh.length} already migrated`);

  let done = 0;
  for (const { pubkey, account } of stale) {
    const owner = new PublicKey(account.data.subarray(16, 48));
    if (!owner.equals(kp.publicKey)) { console.log(`  skip ${pubkey.toBase58().slice(0, 8)} — not ours`); continue; }
    await (prog.methods as any).migrateCard()
      .accounts({ card: pubkey, owner: kp.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    done += 1;
    process.stdout.write(`  migrated ${pubkey.toBase58().slice(0, 8)}…\r`);
  }
  console.log(`\nmigrated ${done}`);

  const readable = await (prog.account as any).card.all();
  console.log(`typed read now works: ${readable.length} cards decode`);
}
main().catch((e) => { console.error(e); process.exit(1); });
