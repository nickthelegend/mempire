/**
 * Dumps the compiled transaction message an ER rejects.
 *
 * "loads a writable account that cannot be written" is a sanitization error and
 * names no account, so this prints the message header and every account key with
 * its resolved writable/signer flags — the only way to see which index the
 * validator is objecting to — then simulates and prints the real logs.
 *
 * Run: npx tsx scripts/diag-er-message.ts <logPubkey>
 */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function main() {
  const logKey = new PublicKey(process.argv[2]);
  const erUrl = process.env.ER_RPC ?? 'http://127.0.0.1:7799';
  const erConn = new Connection(erUrl, 'confirmed');
  process.on('unhandledRejection', () => {});

  const idl = JSON.parse(readFileSync(join(__dirname, '../target/idl/mempire_rollup.json'), 'utf8'));
  const reader = new anchor.Program(
    idl, new anchor.AnchorProvider(erConn, new anchor.Wallet(Keypair.generate()), { commitment: 'confirmed' }),
  );
  const data: any = await (reader.account as any).matchLog.fetch(logKey);
  const playerA = new PublicKey(data.players[0]);

  const ix = await reader.methods.playCard(9999, 0, 0, 0)
    .accounts({ log: logKey, player: playerA })
    .instruction();

  console.log('instruction program:', ix.programId.toBase58());
  console.log('instruction keys:');
  for (const k of ix.keys) {
    console.log(`  ${k.pubkey.toBase58()}  writable=${k.isWritable} signer=${k.isSigner}`);
  }

  const tx = new anchor.web3.Transaction().add(ix);
  tx.feePayer = playerA;
  tx.recentBlockhash = (await erConn.getLatestBlockhash()).blockhash;

  const msg = tx.compileMessage();
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = msg.header;
  console.log('\ncompiled message header:', msg.header);
  console.log('account keys (index: key  role):');
  msg.accountKeys.forEach((k, i) => {
    const isSigner = i < numRequiredSignatures;
    const writableSigner = i < numRequiredSignatures - numReadonlySignedAccounts;
    const writableUnsigned = i >= numRequiredSignatures
      && i < msg.accountKeys.length - numReadonlyUnsignedAccounts;
    const writable = writableSigner || writableUnsigned;
    console.log(`  ${i}: ${k.toBase58()}  ${writable ? 'W' : 'r'}${isSigner ? 'S' : ' '}`);
  });

  console.log('\nsimulating on the ER…');
  try {
    const sim = await erConn.simulateTransaction(tx, [] as never);
    console.log('err:', JSON.stringify(sim.value.err));
    console.log('logs:');
    (sim.value.logs ?? []).forEach((l) => console.log('  ', l));
  } catch (e: any) {
    console.log('simulate threw:', String(e?.message ?? e).slice(0, 200));
    if (typeof e?.getLogs === 'function') {
      try { console.log('getLogs:', await e.getLogs(erConn)); } catch { /* none */ }
    }
    console.log('transactionLogs:', e?.transactionLogs);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
