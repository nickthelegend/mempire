import nacl from 'tweetnacl';
import bs58 from 'bs58';

/**
 * Proving who you are to the API.
 *
 * The server used to identify a caller by the wallet address in the URL — an
 * address it publishes itself through the ladder and the clan pages. So anyone
 * could read a rival's address off a public endpoint and write to their record.
 * It now demands an ed25519 signature over a timestamped, per-action message,
 * and this is the client half of that.
 *
 * # Guests can sign too
 *
 * Guest mode existed so the whole game is playable without a wallet
 * extension, and its address used to be forty random base58 characters — a
 * string that looks like a pubkey and is not one. Nothing could sign for it,
 * so once the server demanded signatures a guest would have been locked out of
 * every write: no ladder, no clan, no saved progress.
 *
 * A guest now gets a real ed25519 keypair, generated in the browser and kept
 * in localStorage, and their address is its actual public key. That makes
 * guest identity exactly as provable as wallet identity — the difference is
 * only where the key lives and that this one holds no funds.
 *
 * The secret key is stored unencrypted. That is fine for precisely what it
 * guards: a devnet ladder position and a clan tag. It must never be used for
 * anything that holds value, and it is generated fresh rather than derived
 * from anything the player might reuse elsewhere.
 */

const GUEST_SK = 'mempire_guest_sk';

/** The bytes the server will verify. Must match `authMessage` in server/auth.js. */
export function authMessage(address: string, action: string, ts: number): string {
  return `Mempire\naction: ${action}\nwallet: ${address}\nts: ${ts}`;
}

/** The guest's keypair, created on first use and reused thereafter. */
function guestKeypair(): nacl.SignKeyPair {
  try {
    const saved = localStorage.getItem(GUEST_SK);
    if (saved) return nacl.sign.keyPair.fromSecretKey(bs58.decode(saved));
  } catch { /* private mode, or a corrupt entry — fall through and make one */ }
  const kp = nacl.sign.keyPair();
  try { localStorage.setItem(GUEST_SK, bs58.encode(kp.secretKey)); } catch { /* ignore */ }
  return kp;
}

/** The guest's address: the real base58 public key of the keypair above. */
export function guestAddress(): string {
  return bs58.encode(guestKeypair().publicKey);
}

export interface Signed {
  address: string;
  ts: number;
  signature: string;
}

/**
 * Signs `action` as `address`.
 *
 * `walletSign` is the connected adapter's `signMessage` when there is one.
 * Returns null when this identity cannot sign — a connected wallet that does
 * not support message signing, or a rejected prompt. Callers must treat null
 * as "do not send", not as "send unsigned": an unsigned write is a 401, and a
 * silent 401 looks to a player like the game forgot their progress.
 */
export async function signAction(
  address: string,
  action: string,
  walletSign?: (msg: Uint8Array) => Promise<Uint8Array>,
): Promise<Signed | null> {
  const ts = Date.now();
  const bytes = new TextEncoder().encode(authMessage(address, action, ts));
  try {
    const sig = walletSign
      ? await walletSign(bytes)
      : nacl.sign.detached(bytes, guestKeypair().secretKey);
    return { address, ts, signature: bs58.encode(sig) };
  } catch {
    return null;
  }
}

/**
 * The guest keypair as a Solana transaction signer.
 *
 * # Why this exists
 *
 * A guest already holds a real ed25519 keypair with a real public key — the
 * only thing separating it from a wallet was that nothing let it sign a
 * *transaction*, only a message. So guest mode could read the chain, hold a
 * ladder position and join a clan, but the moment a match wanted to escrow a
 * stake it fell back to "playing for rating only". The address was real, the
 * funds could be real, and the game refused anyway.
 *
 * Wiring it up means someone can open the site, get a fundable address, and
 * play a genuinely on-chain staked match without installing anything.
 *
 * # Why it is devnet-only
 *
 * The secret key sits unencrypted in localStorage. That is an acceptable place
 * to keep a devnet key guarding play funds and a ladder row. It is not an
 * acceptable place to keep anything holding real value: any script on the page
 * can read it, it does not survive a cleared browser, and there is no recovery
 * phrase. So this returns null off devnet, and the UI routes those players to
 * a real wallet instead of quietly giving them a worse one.
 */
export function guestSolanaSigner(cluster: string): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} | null {
  if (cluster !== 'devnet') return null;
  const kp = guestKeypair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** Wipe the guest key. The only way to abandon a browser-held identity. */
export function clearGuestIdentity(): void {
  try { localStorage.removeItem(GUEST_SK); } catch { /* nothing to clear */ }
  markGuestActive(false);
}

/**
 * Whether this browser is mid-session as a guest.
 *
 * Separate from the key itself, and deliberately so: `guestKeypair` *creates* a
 * key when it finds none, so any "do we have a guest?" check written against
 * the key would mint an identity for a first-time visitor and skip the connect
 * screen entirely. This flag only ever says yes to someone who already chose
 * Play as Guest — which is what lets a reload put them back where they were
 * instead of dropping them on Connect Wallet with a live keypair in storage.
 */
const GUEST_ON = 'mempire_guest_on';

export function markGuestActive(on: boolean): void {
  try {
    if (on) localStorage.setItem(GUEST_ON, '1');
    else localStorage.removeItem(GUEST_ON);
  } catch { /* private mode — the session simply will not survive a reload */ }
}

export function guestWasActive(): boolean {
  try { return localStorage.getItem(GUEST_ON) === '1'; } catch { return false; }
}
