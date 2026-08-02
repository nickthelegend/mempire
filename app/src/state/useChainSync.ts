import { useEffect } from 'react';
import { useChain } from './chain';
import { useLadder } from './ladder';
import { signer, useWallet } from './wallet';

/**
 * Keeps onchain state in step with the wallet.
 *
 * Boots the registry read once regardless of connection, because a visitor who
 * has connected nothing should still see the real coin registry — that read needs
 * no signer. Then loads wallet-scoped data whenever the address changes.
 *
 * Mounted once, in Shell.
 */
export function useChainSync(): void {
  const address = useWallet((s) => s.address);
  const connected = useWallet((s) => s.connected);
  const isGuest = useWallet((s) => s.isGuest);
  const init = useChain((s) => s.init);
  const loadWallet = useChain((s) => s.loadWallet);
  const clearWallet = useChain((s) => s.clearWallet);

  useEffect(() => { void init(); }, [init]);

  // Ladder standing is per-wallet and read-only here; the match store writes it.
  useEffect(() => {
    if (connected && address) {
      void useLadder.getState().load(address);
      void useLadder.getState().loadTop();
    } else {
      useLadder.getState().reset();
    }
  }, [connected, address]);

  useEffect(() => {
    if (!connected || !address) { clearWallet(); return; }
    // Guest passes a null adapter, which is what pins `mode` to 'simulated'.
    void loadWallet(address, isGuest ? null : signer());
  }, [connected, address, isGuest, loadWallet, clearWallet]);
}
