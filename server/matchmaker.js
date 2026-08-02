/**
 * Human matchmaking — the WebSocket half of the API.
 *
 * The clients run the same deterministic lockstep sim; this service never
 * simulates anything. It does exactly three jobs:
 *
 *  1. **Pair** two queued players in the same tier and hand both the same
 *     match id, seed and start time.
 *  2. **Relay** card-play inputs between them, untouched.
 *  3. **Referee hashes.** Both clients report a state hash every 40 ticks;
 *     the first mismatched pair means the sims diverged, and both sides are
 *     told to void the match. A voided match returns stakes and rakes nothing
 *     — divergence is detected and neutralised, never silently ignored.
 *
 * The seed is derived from the match id and both deck commitments, so neither
 * player (nor this server picking who is player 0) can grind a favourable
 * opening hand.
 */
import { WebSocketServer } from 'ws';

const TIERS = 4;
const HASH_WINDOW = 400; // remember this many recent checkpoint ticks per match

/**
 * A deck is eight {coinId, name, archetype, level} entries. Validated here not
 * to enforce game rules — the sims do that — but because this payload is
 * relayed verbatim into the *other* player's createMatch. Junk must fail at
 * the door of the sender, never in the runtime of their opponent.
 */
function validDeck(deck) {
  return Array.isArray(deck) && deck.length === 8 && deck.every((c) => c
    && typeof c.coinId === 'string' && c.coinId.length > 0 && c.coinId.length <= 64
    && typeof c.name === 'string' && c.name.length <= 24
    && Number.isInteger(c.archetype) && c.archetype >= 0 && c.archetype <= 5
    && Number.isInteger(c.level) && c.level >= 1 && c.level <= 10);
}

/** ~4 plays/second sustained is beyond any human; beyond it is a flood. */
const INPUT_BUCKET = { capacity: 12, refillPerSec: 4 };

/** FNV-1a over a string, matching the client's hash discipline. */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

let nextMatchId = 1;

export function registerMatchmaker(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  /** tier → { ws, address, name, power, deck, deckHash } */
  const queues = new Map();
  /** matchId → { players: [wsA, wsB], addr: [a, b], hashes: Map<tick, [hA, hB]>, done } */
  const matches = new Map();

  const send = (ws, msg) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  function leaveQueue(ws) {
    for (const [tier, entry] of queues) {
      if (entry.ws === ws) queues.delete(tier);
    }
  }

  function endMatch(id) {
    const m = matches.get(id);
    if (m) { m.done = true; matches.delete(id); }
  }

  function opponentOf(m, ws) {
    return m.players[0] === ws ? m.players[1] : m.players[0];
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      switch (msg.t) {
        case 'queue': {
          const tier = Number(msg.tier);
          if (!Number.isInteger(tier) || tier < 0 || tier >= TIERS) return;
          if (!msg.address || !validDeck(msg.deck)) return;
          // A socket already in a live match cannot queue for another — that
          // would orphan the first match's opponent mid-battle.
          if (matches.has(ws.matchId)) return;
          leaveQueue(ws); // one queue slot per socket

          const waiting = queues.get(tier);
          // Same wallet in both seats would be a self-match; the program
          // refuses it onchain, so the matchmaker refuses it here too.
          if (waiting && waiting.ws.readyState === 1 && waiting.address !== msg.address) {
            queues.delete(tier);
            const id = nextMatchId;
            nextMatchId += 1;
            // Order-independent seed: neither player benefits from being first.
            const seed = (fnv(`${id}`) ^ fnv(String(msg.deckHash ?? '')) ^ fnv(String(waiting.deckHash ?? ''))) >>> 0;
            const startAt = Date.now() + 2200; // both clients count down to this
            const m = {
              players: [waiting.ws, ws],
              addr: [waiting.address, msg.address],
              hashes: new Map(),
              done: false,
              createdAt: Date.now(),
            };
            matches.set(id, m);
            waiting.ws.matchId = id;
            ws.matchId = id;

            send(waiting.ws, {
              t: 'matched', matchId: id, role: 0, seed: seed || 0x9e3779b9, startAt,
              opponent: { address: msg.address, name: msg.name ?? null, power: msg.power ?? 0, deck: msg.deck },
            });
            send(ws, {
              t: 'matched', matchId: id, role: 1, seed: seed || 0x9e3779b9, startAt,
              opponent: { address: waiting.address, name: waiting.name ?? null, power: waiting.power ?? 0, deck: waiting.deck },
            });
          } else {
            queues.set(tier, {
              ws, address: msg.address, name: msg.name ?? null,
              power: msg.power ?? 0, deck: msg.deck, deckHash: msg.deckHash ?? '',
            });
            send(ws, { t: 'queued' });
          }
          break;
        }

        case 'cancel': {
          leaveQueue(ws);
          send(ws, { t: 'cancelled' });
          break;
        }

        case 'input': {
          const m = matches.get(ws.matchId);
          if (!m || m.done) return;
          const i = msg.input;
          // Shape-check only — the sims validate the play. The relay must not
          // become a second rules engine that can disagree with the first.
          if (!i || ![i.tick, i.player, i.deckIndex, i.x, i.y].every(Number.isFinite)) return;
          // Token bucket per socket: a flooding client gets its excess dropped
          // here instead of amplified into the opponent's tab.
          const now = Date.now();
          ws.tokens = Math.min(
            INPUT_BUCKET.capacity,
            (ws.tokens ?? INPUT_BUCKET.capacity) + ((now - (ws.tokensAt ?? now)) / 1000) * INPUT_BUCKET.refillPerSec,
          );
          ws.tokensAt = now;
          if (ws.tokens < 1) return;
          ws.tokens -= 1;
          send(opponentOf(m, ws), { t: 'input', input: i });
          break;
        }

        case 'hash': {
          const m = matches.get(ws.matchId);
          if (!m || m.done) return;
          const tick = Number(msg.tick);
          const hash = Number(msg.hash) >>> 0;
          if (!Number.isInteger(tick)) return;
          const side = m.players[0] === ws ? 0 : 1;
          const pair = m.hashes.get(tick) ?? [null, null];
          pair[side] = hash;
          m.hashes.set(tick, pair);
          if (pair[0] !== null && pair[1] !== null) {
            if (pair[0] !== pair[1]) {
              // The one unacceptable outcome is two players seeing two
              // different games and one of them paying for it.
              send(m.players[0], { t: 'desync', tick });
              send(m.players[1], { t: 'desync', tick });
              endMatch(ws.matchId);
            } else {
              m.hashes.delete(tick);
            }
          }
          // bound memory on a match that never reports the same tick twice
          if (m.hashes.size > HASH_WINDOW) {
            const oldest = Math.min(...m.hashes.keys());
            m.hashes.delete(oldest);
          }
          break;
        }

        case 'ended': {
          // Either side reporting a finished sim closes the room; the clients
          // settle locally and record results through the HTTP API.
          endMatch(ws.matchId);
          break;
        }

        default:
          break;
      }
    });

    ws.on('close', () => {
      leaveQueue(ws);
      const m = matches.get(ws.matchId);
      if (m && !m.done) {
        // A vanished opponent is a forfeit, and the survivor is told so.
        send(opponentOf(m, ws), { t: 'opponent_left' });
        endMatch(ws.matchId);
      }
    });
  });

  // Reap dead sockets so a phone that lost signal frees its queue slot, and
  // sweep match rooms whose clients both vanished without a close frame — a
  // match outlives regulation + overtime + grace at 10 minutes, never longer.
  const MATCH_TTL_MS = 10 * 60_000;
  const reaper = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const [id, m] of matches) {
      if (now - (m.createdAt ?? 0) > MATCH_TTL_MS) matches.delete(id);
    }
  }, 30_000);
  wss.on('close', () => clearInterval(reaper));

  console.log('matchmaker on /ws');
  return wss;
}
