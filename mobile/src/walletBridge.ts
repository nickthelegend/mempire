import { transact, Web3MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';

/**
 * Mobile Wallet Adapter, reachable from inside the WebView.
 *
 * # Why this exists
 *
 * The game runs in a WebView, and its wallet layer is `@solana/wallet-adapter`
 * — which looks for a browser extension. On Android there is no extension:
 * Phantom and Solflare are apps, and the way to reach them is Mobile Wallet
 * Adapter, which speaks over an Android intent and cannot be called from
 * JavaScript in a web page.
 *
 * So the native side owns MWA and hands the WebView a provider shaped exactly
 * like the one an extension injects. The game connects, signs and sends without
 * knowing it is on a phone, and nothing in the web app had to change.
 *
 * # The contract
 *
 * The page calls `window.phantom.solana.*`. Each call posts a message here,
 * this module runs the real MWA session, and the answer is delivered back by
 * evaluating `window.__mempireResolve(id, ...)` in the page. Requests carry an
 * id because a signature request and a connect can be in flight together.
 *
 * # What is deliberately not cached
 *
 * MWA hands out an `auth_token` that lets a later session reconnect without a
 * second approval. It is held in memory only. Persisting it would mean a
 * process that can sign for the wallet surviving in storage, and the thing this
 * app guards is a wallet — a re-approval per launch is the correct trade.
 */

const CLUSTER = 'devnet';
const IDENTITY = {
  name: 'Mempire',
  uri: 'https://play.mempire.fun',
  icon: 'favicon.ico',
};

/** Held for the life of the process, never written to storage. See above. */
let authToken: string | undefined;
let connected: string | null = null;

export interface BridgeRequest {
  id: number;
  kind: 'connect' | 'disconnect' | 'signTransactions' | 'signMessages' | 'signAndSend';
  /** Base64 payloads: serialized transactions, or raw bytes for a message. */
  payload?: string[];
}

export interface BridgeReply {
  id: number;
  ok: boolean;
  /** base58 address on connect; base64 payloads on signing. */
  result?: string | string[];
  error?: string;
}

/**
 * Run one MWA session and answer the page.
 *
 * Every branch opens its own `transact`, which is how MWA is meant to be used:
 * a session is a foreground handshake with another app, not a connection to
 * hold open. Reusing the auth token is what keeps that from being a fresh
 * approval dialog every time.
 */
export async function handle(req: BridgeRequest): Promise<BridgeReply> {
  try {
    switch (req.kind) {
      case 'connect': {
        const address = await transact(async (wallet: Web3MobileWallet) => {
          const auth = await wallet.authorize({
            chain: `solana:${CLUSTER}`,
            identity: IDENTITY,
            auth_token: authToken,
          });
          authToken = auth.auth_token;
          // MWA returns the address base64-encoded, not base58 — handing that
          // to the page as-is produces a "wallet connected" state whose address
          // matches nothing on chain.
          return new PublicKey(Buffer.from(auth.accounts[0].address, 'base64')).toBase58();
        });
        connected = address;
        return { id: req.id, ok: true, result: address };
      }

      case 'disconnect': {
        // Deliberately local. `deauthorize` would revoke the token in the
        // wallet app too, so the next connect is a full approval — correct for
        // an explicit sign-out, wrong for the page tidying up on navigation,
        // and the page cannot tell us which it meant.
        connected = null;
        return { id: req.id, ok: true };
      }

      case 'signTransactions': {
        const txs = (req.payload ?? []).map(decodeTransaction);
        const signed = await transact(async (wallet: Web3MobileWallet) => {
          const auth = await wallet.authorize({
            chain: `solana:${CLUSTER}`, identity: IDENTITY, auth_token: authToken,
          });
          authToken = auth.auth_token;
          return wallet.signTransactions({ transactions: txs });
        });
        return {
          id: req.id,
          ok: true,
          result: signed.map((t) => Buffer.from(
            t.serialize({ requireAllSignatures: false, verifySignatures: false }),
          ).toString('base64')),
        };
      }

      case 'signMessages': {
        const messages = (req.payload ?? []).map((b) => new Uint8Array(Buffer.from(b, 'base64')));
        const signed = await transact(async (wallet: Web3MobileWallet) => {
          const auth = await wallet.authorize({
            chain: `solana:${CLUSTER}`, identity: IDENTITY, auth_token: authToken,
          });
          authToken = auth.auth_token;
          return wallet.signMessages({
            addresses: [auth.accounts[0].address],
            payloads: messages,
          });
        });
        return {
          id: req.id,
          ok: true,
          // Only the trailing 64 bytes are the signature; MWA returns the
          // signed payload, which is the message with the signature appended.
          result: signed.map((s) => Buffer.from(s.slice(-64)).toString('base64')),
        };
      }

      case 'signAndSend': {
        const txs = (req.payload ?? []).map(decodeTransaction);
        const sigs = await transact(async (wallet: Web3MobileWallet) => {
          const auth = await wallet.authorize({
            chain: `solana:${CLUSTER}`, identity: IDENTITY, auth_token: authToken,
          });
          authToken = auth.auth_token;
          return wallet.signAndSendTransactions({ transactions: txs });
        });
        return { id: req.id, ok: true, result: sigs };
      }

      default:
        return { id: req.id, ok: false, error: `unknown request ${req.kind}` };
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    // A user declining in the wallet app arrives here as an error. The page
    // treats it as one too, which is right — a cancelled signature is a failed
    // signature — but the wording should not read like a crash.
    return {
      id: req.id,
      ok: false,
      error: /declin|reject|cancel/i.test(message) ? 'You declined the request in your wallet.' : message,
    };
  }
}

/** Which address is connected, for the page to read on reload. */
export function currentAddress(): string | null {
  return connected;
}

/**
 * Rebuild a transaction from what the page serialized.
 *
 * Legacy and versioned transactions deserialize differently and MWA accepts
 * both, so the shape is sniffed rather than assumed: byte 0 of a versioned
 * message has its high bit set, which a legacy signature count never does.
 */
function decodeTransaction(b64: string): Transaction | VersionedTransaction {
  const raw = Buffer.from(b64, 'base64');
  try {
    return Transaction.from(raw);
  } catch {
    return VersionedTransaction.deserialize(new Uint8Array(raw));
  }
}
