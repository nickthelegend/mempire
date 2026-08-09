/* Which match is each demo wallet actually in? */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(
  execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)![1].trim(), 'utf8'))));
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' });
const idl = JSON.parse(readFileSync('target/idl/mempire.json', 'utf8'));
const prog = new anchor.Program(idl, provider);
const demo: string[] = JSON.parse(readFileSync('../app/.demo-wallets.json', 'utf8'))
  .map((s: number[]) => Keypair.fromSecretKey(Uint8Array.from(s)).publicKey.toBase58());

async function main() {
  const all: any[] = await (prog.account as any).matchAccount.all();
  const STATE = ['Open', 'Active', 'Settled', 'Void'];
  const mine = all
    .filter((m) => m.account.players.some((p: PublicKey) => demo.includes(p.toBase58())))
    .sort((a, b) => Number(b.account.id) - Number(a.account.id))
    .slice(0, 6);
  console.log('A =', demo[0].slice(0, 8), ' B =', demo[1].slice(0, 8), '\n');
  for (const m of mine) {
    const seats = m.account.players.map((p: PublicKey) => {
      const s = p.toBase58();
      return s === demo[0] ? 'A' : s === demo[1] ? 'B' : `${s.slice(0, 6)}…`;
    });
    console.log(`#${m.account.id}  ${STATE[m.account.state] ?? m.account.state}  seats=[${seats.join(', ')}]  stake=${Number(m.account.stakeLamports) / 1e9}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
