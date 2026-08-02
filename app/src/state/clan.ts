import { create } from 'zustand';
import type { Crest } from '../components/ClanCrest';

/**
 * Clans.
 *
 * Every mutation returns an error string or null, the same contract the
 * collection store uses, so screens handle failure one way throughout the app.
 *
 * The server is the authority: each successful call returns the whole clan and
 * that response replaces local state outright. No optimistic patching — a clan
 * is shared between fifty people, so a guessed local update is wrong more often
 * than it is fast, and "clan filled up while you were tapping" has to be able to
 * surface honestly.
 */

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

export const MEMBER_CAP = 50;
export const CLAN_CREATE_GEM_COST = 500;

export type ClanRole = 'leader' | 'coleader' | 'elder' | 'member';
export type JoinMode = 'open' | 'request' | 'closed';

export const REGIONS = [
  'Global', 'North America', 'South America', 'Europe', 'Asia', 'Africa', 'Oceania',
] as const;

export const ROLE_LABEL: Record<ClanRole, string> = {
  leader: 'Leader',
  coleader: 'Co-leader',
  elder: 'Elder',
  member: 'Member',
};

export interface ClanMember {
  address: string;
  name: string | null;
  role: ClanRole;
  crowns: number;
  lent: number;
  received: number;
  power: number;
  joinedAt: string;
  lastSeenAt: string;
}

export interface ClanFeedItem {
  kind: 'founded' | 'joined' | 'left' | 'kicked' | 'promoted' | 'request';
  address: string;
  at: string;
  /** request only */
  id?: string;
  archetype?: number;
  note?: string | null;
  filledBy?: string | null;
  filledAt?: string;
  /** promoted only */
  role?: ClanRole;
  by?: string;
  name?: string;
}

export interface ClanSummary {
  tag: string;
  name: string;
  description: string;
  crest: Crest;
  region: string;
  requiredPower: number;
  joinMode: JoinMode;
  memberCount: number;
  memberCap: number;
  crowns: number;
  weeklyLent: number;
  createdAt: string;
}

export interface Clan extends ClanSummary {
  members: ClanMember[];
  feed: ClanFeedItem[];
  treasurySol: number;
}

export interface ClanSearchFilters {
  q?: string;
  region?: string;
  maxRequiredPower?: number;
  openOnly?: boolean;
  hasRoom?: boolean;
}

interface ClanState {
  /** The player's own clan, or null. */
  mine: Clan | null;
  /** Search results for the browse sheet. */
  results: ClanSummary[];
  /** A clan being previewed before joining. */
  preview: Clan | null;
  loading: boolean;
  busy: boolean;
  /** Set when the API is unreachable — clans are the one feature that needs it. */
  offline: boolean;
  error: string | null;

  loadMine: (address: string) => Promise<void>;
  search: (f: ClanSearchFilters) => Promise<void>;
  open: (tag: string) => Promise<void>;
  closePreview: () => void;
  create: (address: string, draft: ClanDraft) => Promise<string | null>;
  join: (address: string, tag: string, power: number, name?: string) => Promise<string | null>;
  leave: (address: string) => Promise<string | null>;
  updateSettings: (address: string, patch: Partial<ClanDraft>) => Promise<string | null>;
  setRole: (address: string, target: string, role: ClanRole) => Promise<string | null>;
  kick: (address: string, target: string) => Promise<string | null>;
  requestCard: (address: string, archetype: number, note?: string) => Promise<string | null>;
  lend: (address: string, requestId: string) => Promise<string | null>;
  reportCrowns: (address: string, crowns: number, power: number) => void;
  clear: () => void;
  myRole: (address: string) => ClanRole | null;
}

export interface ClanDraft {
  name: string;
  description: string;
  region: string;
  crest: Crest;
  requiredPower: number;
  joinMode: JoinMode;
  memberName?: string;
  power?: number;
}

/**
 * One request helper so every call fails the same way.
 *
 * The server sends `{ error }` with a human sentence on 4xx; that sentence is
 * what the UI shows, because it is more specific than anything we could invent
 * here ("needs 240 deck power — yours is 180").
 */
async function call<T>(
  path: string, init?: RequestInit,
): Promise<{ data: T | null; error: string | null; offline: boolean }> {
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    if (!res.ok) {
      let msg = `request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body?.error) msg = String(body.error);
      } catch { /* non-JSON error body */ }
      return { data: null, error: msg, offline: false };
    }
    return { data: (await res.json()) as T, error: null, offline: false };
  } catch {
    // Network-level failure, not a rejected request.
    return { data: null, error: 'Clans need the API — start the server', offline: true };
  }
}

const q = (f: ClanSearchFilters): string => {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.region && f.region !== 'Global') p.set('region', f.region);
  if (typeof f.maxRequiredPower === 'number') p.set('maxRequiredPower', String(f.maxRequiredPower));
  if (f.openOnly) p.set('openOnly', 'true');
  if (f.hasRoom) p.set('hasRoom', 'true');
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const useClan = create<ClanState>((set, get) => ({
  mine: null,
  results: [],
  preview: null,
  loading: false,
  busy: false,
  offline: false,
  error: null,

  loadMine: async (address) => {
    if (!address) return;
    set({ loading: true, error: null });
    const { data, error, offline } = await call<Clan | null>(`/api/clans/mine/${address}`);
    set({ mine: data ?? null, loading: false, offline, error: offline ? error : null });
  },

  search: async (f) => {
    set({ loading: true, error: null });
    const { data, error, offline } = await call<{ clans: ClanSummary[] }>(`/api/clans${q(f)}`);
    set({ results: data?.clans ?? [], loading: false, offline, error });
  },

  open: async (tag) => {
    set({ loading: true, error: null, preview: null });
    const { data, error, offline } = await call<Clan>(`/api/clans/${tag}`);
    set({ preview: data, loading: false, offline, error });
  },

  closePreview: () => set({ preview: null }),

  create: async (address, draft) => {
    set({ busy: true, error: null });
    const { data, error, offline } = await call<Clan>('/api/clans', {
      method: 'POST',
      body: JSON.stringify({ address, ...draft }),
    });
    set({ busy: false, offline, error, mine: data ?? get().mine });
    return error;
  },

  join: async (address, tag, power, name) => {
    set({ busy: true, error: null });
    const { data, error, offline } = await call<Clan>(`/api/clans/${tag}/join`, {
      method: 'POST',
      body: JSON.stringify({ address, power, memberName: name }),
    });
    set({ busy: false, offline, error, mine: data ?? get().mine, preview: data ? null : get().preview });
    return error;
  },

  leave: async (address) => {
    const tag = get().mine?.tag;
    if (!tag) return 'you are not in a clan';
    set({ busy: true, error: null });
    const { error, offline } = await call<{ ok: boolean }>(`/api/clans/${tag}/leave`, {
      method: 'POST',
      body: JSON.stringify({ address }),
    });
    set({ busy: false, offline, error, mine: error ? get().mine : null });
    return error;
  },

  updateSettings: async (address, patch) => {
    const tag = get().mine?.tag;
    if (!tag) return 'you are not in a clan';
    set({ busy: true, error: null });
    const { data, error, offline } = await call<Clan>(`/api/clans/${tag}`, {
      method: 'PATCH',
      body: JSON.stringify({ address, ...patch }),
    });
    set({ busy: false, offline, error, mine: data ?? get().mine });
    return error;
  },

  setRole: async (address, target, role) => {
    const tag = get().mine?.tag;
    if (!tag) return 'you are not in a clan';
    set({ busy: true, error: null });
    const { data, error, offline } = await call<Clan>(`/api/clans/${tag}/role`, {
      method: 'POST',
      body: JSON.stringify({ address, target, role }),
    });
    set({ busy: false, offline, error, mine: data ?? get().mine });
    return error;
  },

  kick: async (address, target) => {
    const tag = get().mine?.tag;
    if (!tag) return 'you are not in a clan';
    set({ busy: true, error: null });
    const { data, error, offline } = await call<Clan>(`/api/clans/${tag}/kick`, {
      method: 'POST',
      body: JSON.stringify({ address, target }),
    });
    set({ busy: false, offline, error, mine: data ?? get().mine });
    return error;
  },

  requestCard: async (address, archetype, note) => {
    const tag = get().mine?.tag;
    if (!tag) return 'you are not in a clan';
    set({ busy: true, error: null });
    const { data, error, offline } = await call<Clan>(`/api/clans/${tag}/request`, {
      method: 'POST',
      body: JSON.stringify({ address, archetype, note }),
    });
    set({ busy: false, offline, error, mine: data ?? get().mine });
    return error;
  },

  lend: async (address, requestId) => {
    const tag = get().mine?.tag;
    if (!tag) return 'you are not in a clan';
    set({ busy: true, error: null });
    const { data, error, offline } = await call<Clan>(`/api/clans/${tag}/lend`, {
      method: 'POST',
      body: JSON.stringify({ address, requestId }),
    });
    set({ busy: false, offline, error, mine: data ?? get().mine });
    return error;
  },

  /**
   * Fire-and-forget: a settled match must never wait on, or fail because of,
   * the clan service. The crown total reconciles on the next clan load.
   */
  reportCrowns: (address, crowns, power) => {
    const tag = get().mine?.tag;
    if (!tag || !address || crowns <= 0) return;
    void call(`/api/clans/${tag}/crowns`, {
      method: 'POST',
      body: JSON.stringify({ address, crowns, power }),
    });
  },

  clear: () => set({ mine: null, results: [], preview: null, error: null }),

  myRole: (address) => get().mine?.members.find((m) => m.address === address)?.role ?? null,
}));
