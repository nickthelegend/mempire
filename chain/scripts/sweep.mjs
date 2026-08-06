/**
 * Pull devnet SOL back from the wallets this project scattered it across.
 *
 * Deploys, test seats, the faucet and the treasury all hold balances that are
 * idle between runs. Rather than wait out a rate-limited public faucet, this
 * reclaims what is already ours, leaving each wallet enough for rent and fees.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';

const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const path = process.env.SOLANA_KEYPAIR
  ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)[1].trim();
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, 'utf8'))));

const seeded = (label) => {
  const s = new Uint8Array(32);
  Buffer.from(label).copy(Buffer.from(s.buffer));
  return Keypair.fromSecretKey(nacl.sign.keyPair.fromSeed(s).secretKey);
};

/** Left behind so each wallet can still pay rent and a few signatures. */
const KEEP = 0.06 * LAMPORTS_PER_SOL;

const sources = [
  ['e2e seat A', seeded('mempire-browser-e2e-a-v1')],
  ['e2e seat B', seeded('mempire-browser-e2e-b-v1')],
  ['staked-match bob', Keypair.fromSeed(new Uint8Array(Buffer.concat([Buffer.from('mempire-e2e-opponent-v1'), Buffer.alloc(32)]).subarray(0, 32)))],
  ['devnet treasury', Keypair.fromSeed(new Uint8Array(Buffer.concat([Buffer.from('mempire-devnet-treasury-v1'), Buffer.alloc(32)]).subarray(0, 32)))],
  ['faucet', Keypair.fromSeed(new Uint8Array(Buffer.concat([Buffer.from('mempire-devnet-faucet-v1'), Buffer.alloc(32)]).subarray(0, 32)))],
];

let total = 0;
for (const [name, kp] of sources) {
  const bal = await conn.getBalance(kp.publicKey);
  if (bal <= KEEP) { console.log(`${name.padEnd(18)} ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL — nothing spare`); continue; }
  const move = bal - KEEP - 5000;
  if (move <= 0) continue;
  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: kp.publicKey, toPubkey: admin.publicKey, lamports: move,
    }));
    const { blockhash } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash; tx.feePayer = kp.publicKey; tx.sign(kp);
    await conn.confirmTransaction(await conn.sendRawTransaction(tx.serialize()), 'confirmed');
    total += move;
    console.log(`${name.padEnd(18)} swept ${(move / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  } catch (e) {
    console.log(`${name.padEnd(18)} could not sweep: ${String(e.message).slice(0, 60)}`);
  }
}
console.log(`\nreclaimed ${(total / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
console.log(`admin now ${((await conn.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
