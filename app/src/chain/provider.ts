import { AnchorProvider, Program, type Idl } from '@coral-xyz/anchor';
import type { Adapter } from '@solana/wallet-adapter-base';
import { Connection, PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import idl from './mempire.idl.json';
import { PROGRAM_ID } from './pdas';

/**
 * The connection to the deployed program.
 *
 * Two capability tiers, kept explicit because they behave differently and the
 * UI has to tell the truth about which one it is in:
 *
 *  - **read** — always available, no wallet needed. Coins, config, cards,
 *    matches. This is what makes the app show real onchain data to a visitor
 *    who has not connected anything.
 *  - **write** — needs an adapter that can actually sign. Guest mode cannot,
 *    by construction: it has an address but no keypair. Anything that would
 *    submit a transaction must check `canSign` first rather than failing at
 *    signature time with a confusing wallet error.
 */

const RPC_URL = (import.meta.env.VITE_RPC_URL as string | undefined)
  ?? 'https://api.devnet.solana.com';

export const CLUSTER = (import.meta.env.VITE_CLUSTER as string | undefined) ?? 'devnet';

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      // The public devnet RPC is slow under load; the default 30s times out on
      // confirmations that do in fact land.
      confirmTransactionInitialTimeout: 90_000,
    });
  }
  return connection;
}

/** Minimal signing surface Anchor needs. An adapter satisfies it or it doesn't. */
interface SigningWallet {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

function asSigningWallet(adapter: Adapter | null): SigningWallet | null {
  if (!adapter?.publicKey) return null;
  const a = adapter as unknown as Partial<SigningWallet>;
  if (typeof a.signTransaction !== 'function') return null;
  return {
    publicKey: adapter.publicKey,
    signTransaction: a.signTransaction.bind(adapter) as SigningWallet['signTransaction'],
    signAllTransactions: (typeof a.signAllTransactions === 'function'
      ? a.signAllTransactions.bind(adapter)
      // Not every adapter implements the batch path; signing one at a time is
      // equivalent, just more prompts.
      : (async <T extends Transaction | VersionedTransaction>(txs: T[]) => {
        const out: T[] = [];
        for (const tx of txs) out.push(await (a.signTransaction as SigningWallet['signTransaction'])(tx));
        return out;
      })) as SigningWallet['signAllTransactions'],
  };
}

/**
 * A read-only wallet. Anchor requires *a* wallet to build a provider even for
 * fetches; this one throws loudly if anything tries to sign through it, so a
 * missing `canSign` check surfaces as a clear error rather than a silent no-op.
 */
const READ_ONLY_KEY = new PublicKey('11111111111111111111111111111111');
const readOnlyWallet: SigningWallet = {
  publicKey: READ_ONLY_KEY,
  signTransaction: () => { throw new Error('read-only provider cannot sign'); },
  signAllTransactions: () => { throw new Error('read-only provider cannot sign'); },
};

export function getProvider(adapter: Adapter | null = null): AnchorProvider {
  const wallet = asSigningWallet(adapter) ?? readOnlyWallet;
  return new AnchorProvider(getConnection(), wallet as never, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
}

export function getProgram(adapter: Adapter | null = null): Program<Idl> {
  return new Program(idl as Idl, getProvider(adapter));
}

/** True when this adapter can actually submit a transaction. */
export function canSign(adapter: Adapter | null): boolean {
  return asSigningWallet(adapter) !== null;
}

export { PROGRAM_ID };

/** Explorer link for a signature or address — devnet needs the cluster param. */
export function explorerUrl(idOrSig: string, kind: 'tx' | 'address' = 'tx'): string {
  return `https://explorer.solana.com/${kind}/${idOrSig}?cluster=${CLUSTER}`;
}
