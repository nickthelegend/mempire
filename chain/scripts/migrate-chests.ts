/**
 * One-off: reclaim chest rails written under the pre-`earned` layout.
 *
 * `PlayerChests` gained a two-byte entitlement counter, so a fixed-size account
 * written under the old struct is two bytes short of what the new one
 * deserialises — every read of it throws, and `init_chests` will not touch an
 * address that already exists. Undelegate if needed, close, recreate.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import idl from '../target/idl/mempire_rollup.json';

const BASE = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';
const ROUTER = process.env.ROUTER_RPC ?? 'https://devnet-router.magicblock.app/';
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function routerStatus(account: PublicKey): Promise<any | null> {
  try {
    const res = await fetch(ROUTER, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [account.toBase58()] }),
    });
    const body: any = await res.json();
    return body?.error ? null : body?.result ?? null;
  } catch { return null; }
}

async function main() {
  const conn = new Connection(BASE, { commitment: 'confirmed' });
  const keypairPath = process.env.SOLANA_KEYPAIR
    ?? (execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)?.[1]?.trim())
    ?? join(homedir(), '.config/solana/id.json');
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))));
  const wallet = new anchor.Wallet(kp);
  const prog = new anchor.Program(idl as any,
    new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' }));

  const [rail] = PublicKey.findProgramAddressSync(
    [Buffer.from('chests'), kp.publicKey.toBuffer()], prog.programId);

  const info = await conn.getAccountInfo(rail);
  console.log('rail', rail.toBase58(),
    info ? `${info.data.length} bytes · owner ${info.owner.toBase58()}` : 'absent');
  if (!info) { console.log('nothing to migrate'); return; }

  if (info.owner.equals(DELEGATION_PROGRAM_ID)) {
    const st = await routerStatus(rail);
    const endpoint = st?.validatorIdentityFqdn ?? st?.fqdn;
    if (endpoint) {
      console.log('undelegating from', endpoint);
      const erConn = new Connection(endpoint, { commitment: 'confirmed' });
      const erProg = new anchor.Program(idl as any,
        new anchor.AnchorProvider(erConn, wallet, { commitment: 'confirmed' }));
      await erProg.methods.commitChests()
        .accounts({ owner: kp.publicKey, chests: rail } as any).rpc();
      for (let i = 0; i < 40; i += 1) {
        await sleep(1500);
        const now = await conn.getAccountInfo(rail);
        if (now && now.owner.equals(prog.programId)) { console.log('back on base layer'); break; }
      }
    }
  }

  await prog.methods.closeChests()
    .accounts({ chests: rail, owner: kp.publicKey } as any).rpc();
  console.log('closed');

  await prog.methods.initChests()
    .accounts({ chests: rail, owner: kp.publicKey, systemProgram: SystemProgram.programId } as any).rpc();
  const fresh: any = await prog.account.playerChests.fetch(rail);
  console.log(`recreated · earned=${fresh.earned} · slots=${fresh.slots.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
