import { create } from 'zustand';

// Real wallet connect (Phantom/Backpack/Solflare via injected providers),
// simulated SOL economy. On devnet the balance is simulated so judges without
// funded wallets still play; the address and the connection are real.

interface InjectedProvider {
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
  disconnect?: () => Promise<void>;
  publicKey?: { toString(): string } | null;
  isConnected?: boolean;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    phantom?: { solana?: InjectedProvider & { isPhantom?: boolean } };
    solana?: InjectedProvider & { isPhantom?: boolean };
    backpack?: InjectedProvider & { isBackpack?: boolean };
    solflare?: InjectedProvider & { isSolflare?: boolean };
  }
}

export type WalletId = 'phantom' | 'backpack' | 'solflare' | 'guest';

export interface WalletOption {
  id: WalletId;
  name: string;
  tagline: string;
  installUrl: string;
  detect: () => InjectedProvider | null;
}

export const WALLETS: WalletOption[] = [
  {
    id: 'phantom',
    name: 'Phantom',
    tagline: 'Most popular on Solana',
    installUrl: 'https://phantom.app/download',
    detect: () => window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null),
  },
  {
    id: 'backpack',
    name: 'Backpack',
    tagline: 'xNFT native',
    installUrl: 'https://backpack.app/download',
    detect: () => (window.backpack?.isBackpack ? window.backpack : null),
  },
  {
    id: 'solflare',
    name: 'Solflare',
    tagline: 'Web & mobile',
    installUrl: 'https://solflare.com/download',
    detect: () => (window.solflare?.isSolflare ? window.solflare : null),
  },
];

export const isInstalled = (w: WalletOption): boolean => {
  try {
    return w.detect() !== null;
  } catch {
    return false;
  }
};

const GUEST_ADDRESS = 'ANoNKiNG7xR4qJ9mPvE2wYbTzC5dHgU8fLsWjkQ3VtXu';
const START_BALANCE = 12.4;

interface WalletState {
  connected: boolean;
  connecting: WalletId | null;
  error: string | null;
  address: string;
  walletId: WalletId | null;
  walletName: string;
  sol: number;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  connect: (id: WalletId) => Promise<void>;
  autoConnect: () => Promise<void>;
  disconnect: () => void;
  spend: (amount: number) => boolean;
  receive: (amount: number) => void;
}

export const useWallet = create<WalletState>((set, get) => ({
  connected: false,
  connecting: null,
  error: null,
  address: '',
  walletId: null,
  walletName: '',
  sol: 0,
  pickerOpen: false,

  openPicker: () => set({ pickerOpen: true, error: null }),
  closePicker: () => set({ pickerOpen: false, connecting: null }),

  connect: async (id) => {
    if (get().connecting) return;
    set({ connecting: id, error: null });

    if (id === 'guest') {
      set({
        connected: true, connecting: null, pickerOpen: false,
        address: GUEST_ADDRESS, walletId: 'guest', walletName: 'Guest',
        sol: START_BALANCE,
      });
      return;
    }

    const opt = WALLETS.find((w) => w.id === id);
    const provider = opt?.detect() ?? null;
    if (!opt || !provider) {
      set({ connecting: null, error: `${opt?.name ?? 'That wallet'} isn't installed` });
      return;
    }
    try {
      const res = await provider.connect();
      set({
        connected: true, connecting: null, pickerOpen: false,
        address: res.publicKey.toString(),
        walletId: id, walletName: opt.name,
        sol: START_BALANCE,
      });
      provider.on?.('disconnect', () => get().disconnect());
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Connection rejected';
      set({ connecting: null, error: /reject|denied|cancel/i.test(msg) ? 'Connection rejected' : msg });
    }
  },

  /** Silent reconnect for a wallet the user already trusted this browser. */
  autoConnect: async () => {
    if (get().connected) return;
    for (const w of WALLETS) {
      const p = w.detect();
      if (!p) continue;
      try {
        const res = await p.connect({ onlyIfTrusted: true });
        set({
          connected: true, address: res.publicKey.toString(),
          walletId: w.id, walletName: w.name, sol: START_BALANCE,
        });
        p.on?.('disconnect', () => get().disconnect());
        return;
      } catch {
        // not trusted yet — leave disconnected, the picker handles it
      }
    }
  },

  disconnect: () => {
    const id = get().walletId;
    if (id && id !== 'guest') {
      try {
        WALLETS.find((w) => w.id === id)?.detect()?.disconnect?.();
      } catch { /* provider already gone */ }
    }
    set({ connected: false, address: '', walletId: null, walletName: '', sol: 0, pickerOpen: false });
  },

  spend: (amount) => {
    if (get().sol < amount) return false;
    set((s) => ({ sol: +(s.sol - amount).toFixed(4) }));
    return true;
  },
  receive: (amount) => set((s) => ({ sol: +(s.sol + amount).toFixed(4) })),
}));
