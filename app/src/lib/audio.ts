/**
 * Tiny audio bus. Preloads a small pool per sound so rapid-fire hits don't
 * cut each other off, respects a persisted mute, and never throws when the
 * browser blocks autoplay before the first gesture.
 */
export type Sfx = 'deploy' | 'hit' | 'tower' | 'victory' | 'defeat' | 'coin';

const FILES: Record<Sfx, string> = {
  deploy: '/sfx/sfx_deploy.mp3',
  hit: '/sfx/sfx_hit.mp3',
  tower: '/sfx/sfx_tower.mp3',
  victory: '/sfx/sfx_victory.mp3',
  defeat: '/sfx/sfx_defeat.mp3',
  coin: '/sfx/sfx_coin.mp3',
};

const VOLUME: Record<Sfx, number> = {
  deploy: 0.5, hit: 0.28, tower: 0.6, victory: 0.65, defeat: 0.55, coin: 0.45,
};

const POOL_SIZE = 3;
const STORAGE_KEY = 'mempire.muted';

const pools = new Map<Sfx, HTMLAudioElement[]>();
const cursor = new Map<Sfx, number>();
let music: HTMLAudioElement | null = null;
let muted = false;
let ready = false;

try {
  muted = localStorage.getItem(STORAGE_KEY) === '1';
} catch { /* private mode — default to unmuted */ }

export const isMuted = (): boolean => muted;

export function setMuted(next: boolean): void {
  muted = next;
  try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  if (music) music.muted = next;
}

/** Build the pools once, lazily — cheap, and keeps first paint clean. */
export function initAudio(): void {
  if (ready) return;
  ready = true;
  (Object.keys(FILES) as Sfx[]).forEach((k) => {
    const pool = Array.from({ length: POOL_SIZE }, () => {
      const a = new Audio(FILES[k]);
      a.preload = 'auto';
      a.volume = VOLUME[k];
      return a;
    });
    pools.set(k, pool);
    cursor.set(k, 0);
  });
}

export function play(name: Sfx): void {
  if (muted) return;
  initAudio();
  const pool = pools.get(name);
  if (!pool) return;
  const i = cursor.get(name) ?? 0;
  cursor.set(name, (i + 1) % pool.length);
  const el = pool[i];
  try {
    el.currentTime = 0;
    void el.play().catch(() => { /* autoplay blocked until first gesture */ });
  } catch { /* element busy — skip this hit rather than throw */ }
}

export function startMusic(src = '/sfx/music_battle.m4a', volume = 0.22): void {
  stopMusic();
  const a = new Audio(src);
  a.loop = true;
  a.volume = volume;
  a.muted = muted;
  music = a;
  void a.play().catch(() => { /* blocked until gesture; battle start supplies one */ });
}

export function stopMusic(): void {
  if (!music) return;
  music.pause();
  music.currentTime = 0;
  music = null;
}
