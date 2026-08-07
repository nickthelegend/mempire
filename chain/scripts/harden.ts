/**
 * Take the rug vectors away from a single key.
 *
 * One wallet currently holds four powers over this deployment: it upgrades the
 * program, admins the config, and both mints and freezes $MEMPIRE. On devnet
 * that is convenient. On mainnet it means one key can push a program that
 * drains every escrow, print unlimited supply, or freeze anyone's balance — and
 * "trust me" is not a security model when the answer is checkable on chain.
 *
 * Nothing here is reversible, so nothing runs without `--yes`, and each step
 * reports what it is about to do first.
 *
 *   npx tsx scripts/harden.ts                     # report only, changes nothing
 *   npx tsx scripts/harden.ts --freeze --yes      # revoke freeze authority
 *   npx tsx scripts/harden.ts --mint --yes        # revoke mint authority (fixed supply)
 *   npx tsx scripts/harden.ts --upgrade <PUBKEY> --yes   # hand the program to a multisig
 *
 * On the ordering: revoke freeze first (nothing legitimate uses it), then move
 * the upgrade authority to a Squads multisig, and revoke the mint last — once
 * it is gone the supply is fixed forever, so it wants to be the deliberate
 * final act rather than something done while still iterating.
 */
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  SystemProgram, TransactionInstruction,
} from '@solana/web3.js';
import { AuthorityType, createSetAuthorityInstruction, getMint } from '@solana/spl-token';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RPC = process.env.BASE_RPC ?? 'https://api.devnet.solana.com';
const PROGRAM = new PublicKey('BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valueOf = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const CONFIRMED = has('--yes');

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const keypairPath = process.env.SOLANA_KEYPAIR
    ?? execSync('solana config get', { encoding: 'utf8' }).match(/Keypair Path:\s*(.+)/)?.[1].trim()
    ?? join(homedir(), '.config/solana/id.json');
  const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))));
  const amm = JSON.parse(readFileSync('../app/src/lib/amm.json', 'utf8'));
  const mint = new PublicKey(amm.mempireMint);

  console.log(`cluster   ${RPC}`);
  console.log(`signer    ${authority.publicKey.toBase58()}\n`);

  // ── what one key holds right now ─────────────────────────────────────────
  const info = await getMint(conn, mint);
  const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER)[0];
  const pd = await conn.getAccountInfo(programData);
  // The upgrade authority sits after a 4-byte enum, an 8-byte slot and a
  // 1-byte option flag; absent means the program is immutable.
  const upgradeAuthority = pd && pd.data[12] === 1
    ? new PublicKey(pd.data.subarray(13, 45)).toBase58()
    : null;

  console.log('held today');
  console.log(`  program upgrade   ${upgradeAuthority ?? 'none — immutable'}`);
  console.log(`  $MEMPIRE mint     ${info.mintAuthority?.toBase58() ?? 'revoked — fixed supply'}`);
  console.log(`  $MEMPIRE freeze   ${info.freezeAuthority?.toBase58() ?? 'revoked'}`);
  const same = [upgradeAuthority, info.mintAuthority?.toBase58(), info.freezeAuthority?.toBase58()]
    .filter(Boolean);
  if (same.length > 1 && new Set(same).size === 1) {
    console.log(`\n  all ${same.length} are the same key. That is the finding.`);
  }

  if (!args.some((a) => a.startsWith('--') && a !== '--yes')) {
    console.log('\nreport only. pass --freeze / --mint / --upgrade <PUBKEY> with --yes to change something.');
    return;
  }

  const run = async (label: string, ix: TransactionInstruction[]) => {
    if (!CONFIRMED) {
      console.log(`\nWOULD ${label} — re-run with --yes`);
      return;
    }
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ix), [authority], {
      commitment: 'confirmed',
    });
    console.log(`\n${label}\n  ${sig}`);
  };

  // ── freeze: nothing legitimate uses it ───────────────────────────────────
  if (has('--freeze')) {
    if (!info.freezeAuthority) {
      console.log('\nfreeze authority already revoked');
    } else {
      await run('revoked the freeze authority — no balance can be frozen again', [
        createSetAuthorityInstruction(mint, authority.publicKey, AuthorityType.FreezeAccount, null),
      ]);
    }
  }

  // ── mint: irreversible, and the supply is fixed after it ─────────────────
  if (has('--mint')) {
    if (!info.mintAuthority) {
      console.log('\nmint authority already revoked — supply is fixed');
    } else {
      console.log(`\ncurrent supply ${Number(info.supply) / 10 ** info.decimals} $MEMPIRE`);
      console.log('after this no more can ever be created, by anyone, including you.');
      await run('revoked the mint authority — supply is fixed forever', [
        createSetAuthorityInstruction(mint, authority.publicKey, AuthorityType.MintTokens, null),
      ]);
    }
  }

  // ── upgrade: hand the program to a multisig ──────────────────────────────
  const target = valueOf('--upgrade');
  if (target) {
    const next = new PublicKey(target);
    console.log(`\nhanding program upgrade authority to ${next.toBase58()}`);
    console.log('check that address is a multisig you control and can actually sign with.');
    // `SetAuthority` on the upgradeable loader: variant 4, current authority
    // signs, new authority is the third account.
    const data = Buffer.alloc(4);
    data.writeUInt32LE(4, 0);
    await run('moved the upgrade authority', [new TransactionInstruction({
      programId: LOADER,
      keys: [
        { pubkey: programData, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: next, isSigner: false, isWritable: false },
      ],
      data,
    })]);
  }

  // A no-op reference so the import is not flagged when no branch ran.
  void SystemProgram;
}

main().catch((e) => { console.error(e); process.exit(1); });
