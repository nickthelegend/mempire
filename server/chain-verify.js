/**
 * Reads a settled match off the chain so the leaderboard never has to
 * believe a client about money.
 *
 * `/api/match` used to fold client-asserted `payoutSol`/`potSol`/`escrowed`
 * into the public leaderboard's net-SOL column — one crafted POST per five
 * minutes and the top of the board is fiction. The signature middleware
 * proves *who* is talking, not that what they say happened happened. The
 * chain is what happened.
 *
 * Layouts are decoded by fixed offset from the program's account structs
 * (single source: chain/programs/mempire/src/lib.rs). If the program's
 * account layout ever changes, the discriminator stays the same but offsets
 * shift — bump these together with the program.
 */
import { Connection, PublicKey } from '@solana/web3.js';

const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(
  process.env.MEMPIRE_PROGRAM ?? 'BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP',
);

let conn = null;
const connection = () => (conn ??= new Connection(RPC, 'confirmed'));

const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

const matchPda = (id) => PublicKey.findProgramAddressSync(
  [Buffer.from('match'), u64le(id)], PROGRAM_ID,
)[0];
const configPda = () => PublicKey.findProgramAddressSync(
  [Buffer.from('config')], PROGRAM_ID,
)[0];

// Config { admin 32, treasury 32, mint_fee u64, rake_bps u16, tie_rake_bps u16, ... }
let cachedRake = null;
async function rakeBps() {
  if (cachedRake) return cachedRake;
  const info = await connection().getAccountInfo(configPda());
  if (!info) throw new Error('config account missing');
  const d = info.data;
  cachedRake = {
    rake: d.readUInt16LE(8 + 64 + 8),
    tieRake: d.readUInt16LE(8 + 64 + 8 + 2),
  };
  return cachedRake;
}

export const MATCH_STATE_SETTLED = 2;

/**
 * Returns the verified money facts for `address` in match `matchId`, or null
 * when the chain does not support the claim (no such match, not settled, or
 * the address is not a player). Callers treat null as "no lamports moved".
 */
export async function verifySettledMatch(matchId, address) {
  const id = Number(matchId);
  if (!Number.isInteger(id) || id < 0) return null;

  const info = await connection().getAccountInfo(matchPda(id));
  if (!info || !info.owner.equals(PROGRAM_ID)) return null;

  const d = info.data;
  // MatchAccount { id u64, tier u8, stake u64, players 2x32, deck_hash 64,
  //                power 8, state u8, ..., winner u8 (at 178) }
  const stakeLamports = d.readBigUInt64LE(8 + 8 + 1);
  const players = [
    new PublicKey(d.subarray(25, 57)).toBase58(),
    new PublicKey(d.subarray(57, 89)).toBase58(),
  ];
  const state = d.readUInt8(161);
  const winner = d.readUInt8(178);

  if (state !== MATCH_STATE_SETTLED) return null;
  const seat = players.indexOf(String(address));
  if (seat === -1) return null;

  const { rake, tieRake } = await rakeBps();
  const stake = Number(stakeLamports) / 1e9;
  const pot = stake * 2;

  let netSol;
  let won = false;
  let draw = false;
  if (winner === 2) {
    draw = true;
    netSol = (pot * (1 - tieRake / 10_000)) / 2 - stake;
  } else if (winner === seat) {
    won = true;
    netSol = pot * (1 - rake / 10_000) - stake;
  } else {
    netSol = -stake;
  }
  return { netSol, potSol: pot, won, draw, players };
}
