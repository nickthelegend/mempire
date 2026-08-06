import { Connection, PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
const conn = new Connection('https://api.devnet.solana.com','confirmed');
const idl = JSON.parse(readFileSync('../chain/target/idl/mempire.json','utf8'));
const prog = new anchor.Program(idl, new anchor.AnchorProvider(conn, { publicKey: PublicKey.default, signTransaction: async t=>t, signAllTransactions: async t=>t }, {commitment:'confirmed'}));
const pid = prog.programId;
const b = Buffer.alloc(8); b.writeBigUInt64LE(24n);
const log = PublicKey.findProgramAddressSync([Buffer.from('log'), b], pid)[0];
const info = await conn.getAccountInfo(log);
console.log('log #24:', info ? `owner ${info.owner.toBase58().slice(0,14)} len ${info.data.length}` : 'ABSENT');
if (info && info.owner.equals(pid)) {
  const l = await prog.account.matchLog.fetch(log);
  console.log('claims:', l.claims, '(3 = has not spoken)  ended:', l.ended, ' plays:', l.plays.length);
}
