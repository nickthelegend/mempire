/**
 * Names the exact account an ER refuses to write.
 *
 * `InvalidWritableAccount` / "loads a writable account that cannot be written"
 * does not say which account, so this builds the real instruction, lists every
 * writable meta, and reports each one's ownership on both layers. An account that
 * is writable in the message but not delegated on the ER is the offender.
 *
 * Run: npx tsx scripts/diag-er-writable.ts <logPubkey> [erRpc]
 */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const BASE = process.env.BASE_RPC ?? 'http://127.0.0.1:8899';

async function main() {
  const logKey = new PublicKey(process.argv[2]);
  const erUrl = process.argv[3] ?? process.env.ER_RPC ?? 'http://127.0.0.1:7799';
  const baseConn = new Connection(BASE, 'confirmed');
  const erConn = new Connection(erUrl, 'confirmed');
  process.on('unhandledRejection', () => {});

  const idl = JSON.parse(readFileSync(join(__dirname, '../target/idl/mempire_rollup.json'), 'utf8'));

  // Read the log off the ER to learn who the players are.
  const reader = new anchor.Program(
    idl, new anchor.AnchorProvider(erConn, new anchor.Wallet(Keypair.generate()), { commitment: 'confirmed' }),
  );
  const data: any = await (reader.account as any).matchLog.fetch(logKey);
  const playerA = new PublicKey(data.players[0]);
  console.log(`log     ${logKey.toBase58()}`);
  console.log(`players ${data.players.map((p: any) => new PublicKey(p).toBase58()).join(', ')}`);
  console.log(`plays   ${data.plays.length}  lastTick ${data.lastTick}\n`);

  // Build the instruction exactly as the app would.
  const prog = new anchor.Program(
    idl, new anchor.AnchorProvider(erConn, new anchor.Wallet(Keypair.generate()), { commitment: 'confirmed' }),
  );
  const ix = await prog.methods.playCard(9999, 0, 0, 0)
    .accounts({ log: logKey, player: playerA })
    .instruction();

  // The fee payer is implicitly writable even when it is not a writable meta.
  const metas = [
    { pubkey: playerA, isSigner: true, isWritable: true, note: 'fee payer (implicit)' },
    ...ix.keys.map((k) => ({ ...k, note: 'instruction meta' })),
  ];

  console.log('account'.padEnd(46), 'W  S  base owner'.padEnd(46), 'ER owner');
  for (const m of metas) {
    const b = await baseConn.getAccountInfo(m.pubkey);
    const e = await erConn.getAccountInfo(m.pubkey);
    const bo = b ? b.owner.toBase58() : 'MISSING';
    const eo = e ? e.owner.toBase58() : 'MISSING';
    console.log(
      m.pubkey.toBase58().padEnd(46),
      `${m.isWritable ? 'W' : '-'}  ${m.isSigner ? 'S' : '-'} `,
      bo.padEnd(46),
      eo,
    );
    if (m.isWritable) {
      const delegated = b ? b.owner.equals(DELEGATION_PROGRAM_ID) : false;
      const onEr = e !== null;
      console.log(`${' '.repeat(4)}↳ writable: delegated_on_base=${delegated} present_on_er=${onEr}`
        + `${!delegated ? '  ← NOT DELEGATED (candidate offender)' : ''}`);
    }
  }

  const payerBal = await erConn.getBalance(playerA);
  console.log(`\nfee payer lamports on ER: ${payerBal} (${(payerBal / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  console.log('ER endpoint:', erUrl);
}

main().catch((e) => { console.error(e); process.exit(1); });
