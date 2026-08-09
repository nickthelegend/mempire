/**
 * Read (and optionally clear) a demo wallet's chest rail on the rollup.
 *
 * `rollChestOnchain` gives up silently when the rail has no free slot or a
 * request is already in flight:
 *
 *     if (slot < 0 || rail.pendingSlot !== 255) return;
 *
 * A rail left full by an earlier run therefore produces no VRF, no badge, and
 * no error — the chest simply keeps its local roll and nothing says why.
 *
 *   npx tsx scripts/chest-rail.ts          # report
 *   npx tsx scripts/chest-rail.ts --claim  # free every filled slot
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';

const ROLLUP = new PublicKey('3G4GidvjQd3yQK4bqZfem8Kkmcboygze42RcjrXg5g6N');
const ER = 'https://devnet-as.magicblock.app/';

async function main() {
  const act = process.argv.includes('--claim');
  const demo: Keypair[] = JSON.parse(readFileSync('../app/.demo-wallets.json', 'utf8'))
    .map((s: number[]) => Keypair.fromSecretKey(Uint8Array.from(s)));
  const idl = JSON.parse(readFileSync('target/idl/mempire_rollup.json', 'utf8'));

  for (const [i, kp] of demo.entries()) {
    const label = i === 0 ? 'A' : 'B';
    const erConn = new Connection(ER, 'confirmed');
    const provider = new anchor.AnchorProvider(erConn, new anchor.Wallet(kp), { commitment: 'confirmed' });
    const prog = new anchor.Program(idl, provider);
    const rail = PublicKey.findProgramAddressSync(
      [Buffer.from('chests'), kp.publicKey.toBytes()], ROLLUP)[0];

    let acct: any;
    try {
      acct = await (prog.account as any).playerChests.fetch(rail);
    } catch (e) {
      console.log(`  ${label}: no rail on the rollup (${String(e).slice(0, 60)})`);
      continue;
    }
    const filled = acct.slots
      .map((s: any, n: number) => ({ n, state: s.state }))
      .filter((s: any) => s.state !== 0);
    console.log(`  ${label}  earned=${acct.earned}  pendingSlot=${acct.pendingSlot}  `
      + `filled=[${filled.map((f: any) => `${f.n}:${f.state}`).join(', ') || 'none'}]`);

    if (!act) continue;
    for (const f of filled) {
      try {
        await (prog.methods as any).claimChest(f.n)
          .accounts({ chests: rail, owner: kp.publicKey } as any).rpc();
        console.log(`     freed slot ${f.n}`);
      } catch (e) {
        console.log(`     slot ${f.n} not claimable: ${String(e).slice(0, 70)}`);
      }
    }
  }
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
