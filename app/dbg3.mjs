import { Connection, PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
const conn = new Connection('https://api.devnet.solana.com','confirmed');
const idl = JSON.parse(readFileSync('../chain/target/idl/mempire.json','utf8'));
const prog = new anchor.Program(idl, new anchor.AnchorProvider(conn, { publicKey: PublicKey.default, signTransaction: async t=>t, signAllTransactions: async t=>t }, {commitment:'confirmed'}));
const A = 'cYu5RCMNDawsqqxLkGLaqZnKqNm4LguGveoARqthkcv';
const cards = (await prog.account.card.all()).filter(c=>c.account.owner.toBase58()===A);
const lock = cards[0].account.lockedBy;
console.log('locked to:', lock.toBase58());
const info = await conn.getAccountInfo(lock);
console.log('that account:', info ? `owner ${info.owner.toBase58().slice(0,12)} len ${info.data.length}` : 'DOES NOT EXIST');
try {
  const m = await prog.account.matchAccount.fetch(lock);
  console.log('match #'+m.id, 'state', m.state, '(0=Open 1=Active 2=Settled)', 'winner', m.winner);
} catch(e){ console.log('not a match account:', String(e.message).slice(0,60)); }
