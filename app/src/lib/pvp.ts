import type { InputEvent, MatchCard } from '../sim/types';

/**
 * PvP transport — the client half of the matchmaker.
 *
 * One socket per queue-or-match lifecycle, no reconnect by design: in a
 * lockstep sim a client that drops has already diverged from the shared
 * timeline, so the honest outcomes are exactly two — the opponent wins by
 * forfeit, or the match voids on the next hash check. Reconnection theatre
 * would only delay one of those.
 */

export interface MatchedPayload {
  matchId: number;
  role: 0 | 1;
  seed: number;
  startAt: number;
  opponent: { address: string; name: string | null; power: number; deck: MatchCard[] };
}

export interface PvpCallbacks {
  onQueued?: () => void;
  onMatched?: (m: MatchedPayload) => void;
  onInput?: (input: InputEvent) => void;
  onDesync?: (tick: number) => void;
  onOpponentLeft?: () => void;
  /** Socket failed or closed before a match formed — callers fall back to the bot. */
  onUnavailable?: () => void;
}

function wsUrl(): string {
  const api = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787';
  return `${api.replace(/^http/, 'ws')}/ws`;
}

let socket: WebSocket | null = null;
let callbacks: PvpCallbacks = {};
let matched = false;

export function pvpConnect(cb: PvpCallbacks): void {
  pvpClose();
  callbacks = cb;
  matched = false;

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    cb.onUnavailable?.();
    return;
  }
  socket = ws;

  ws.onmessage = (e) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(String(e.data)); } catch { return; }
    switch (msg.t) {
      case 'queued': callbacks.onQueued?.(); break;
      case 'matched':
        matched = true;
        callbacks.onMatched?.(msg as unknown as MatchedPayload);
        break;
      case 'input': callbacks.onInput?.(msg.input as InputEvent); break;
      case 'desync': callbacks.onDesync?.(Number(msg.tick)); break;
      case 'opponent_left': callbacks.onOpponentLeft?.(); break;
      default: break;
    }
  };

  ws.onerror = () => {
    if (!matched) callbacks.onUnavailable?.();
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (!matched) callbacks.onUnavailable?.();
  };
}

function send(msg: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

export function pvpQueue(payload: {
  address: string; name: string; tier: number; power: number;
  deck: MatchCard[]; deckHash: string;
}): void {
  const go = () => send({ t: 'queue', ...payload });
  if (socket?.readyState === WebSocket.OPEN) go();
  else if (socket) socket.addEventListener('open', go, { once: true });
}

export const pvpSendInput = (input: InputEvent): void => send({ t: 'input', input });
export const pvpSendHash = (tick: number, hash: number): void => send({ t: 'hash', tick, hash });
export const pvpSendEnded = (): void => send({ t: 'ended' });
export const pvpCancel = (): void => send({ t: 'cancel' });

/** Closes without firing onUnavailable — for deliberate teardown. */
export function pvpClose(): void {
  const ws = socket;
  socket = null;
  callbacks = {};
  matched = true; // suppresses the unavailable callback on this close
  try { ws?.close(); } catch { /* already closed */ }
}
