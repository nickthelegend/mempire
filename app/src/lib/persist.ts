/**
 * Player-state sync. Writes are debounced and fire-and-forget: the game must
 * stay fully playable when the API is down, so every failure degrades to
 * local-only rather than surfacing an error mid-match.
 */
import type { MintedCard } from '../state/collection';
import type { MatchResult } from '../state/match';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';
const SAVE_DEBOUNCE_MS = 900;

export interface SavedState {
  cards: MintedCard[];
  deck: string[];
  tier: number;
  sol: number;
  nextId: number;
  history: MatchResult[];
}

let timer: ReturnType<typeof setTimeout> | null = null;
let online = true;

export const isOnline = (): boolean => online;

export async function loadPlayer(address: string): Promise<SavedState | null> {
  try {
    const res = await fetch(`${API}/api/player/${address}`);
    if (!res.ok) throw new Error(String(res.status));
    online = true;
    return (await res.json()) as SavedState | null;
  } catch {
    online = false;
    return null;
  }
}

export function savePlayer(address: string, state: SavedState): void {
  if (!address) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void fetch(`${API}/api/player/${address}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    })
      .then((r) => { online = r.ok; })
      .catch(() => { online = false; });
  }, SAVE_DEBOUNCE_MS);
}

/** Records a settled match for the leaderboard. Never blocks the result screen. */
export function recordMatch(address: string, result: MatchResult): void {
  if (!address) return;
  void fetch(`${API}/api/match/${address}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  }).catch(() => { online = false; });
}

export interface LeaderRow {
  address: string;
  netSol: number;
  wins: number;
  losses: number;
  crowns: number;
  matches: number;
}

export async function loadLeaderboard(): Promise<LeaderRow[]> {
  try {
    const res = await fetch(`${API}/api/leaderboard`);
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as LeaderRow[];
  } catch {
    return [];
  }
}
