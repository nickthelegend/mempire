/**
 * What runs inside the page, before any of the game's own scripts.
 *
 * Two things are planted here:
 *
 *  - `window.phantom.solana` — a provider shaped exactly like a browser
 *    extension's, so `PhantomWalletAdapter` detects it and the game's whole
 *    wallet layer works untouched. Every call is forwarded to the native side,
 *    which owns Mobile Wallet Adapter.
 *  - `window.MempireNative` — the small surface the game can use to ask for a
 *    notification, which a web page on Android cannot schedule for itself once
 *    it is backgrounded.
 *
 * This is a string rather than a module because it is evaluated in the page's
 * context, not this bundle's. It must run before the app's scripts, which is
 * what `injectedJavaScriptBeforeContentLoaded` guarantees.
 */
export const INJECTED_BRIDGE = String.raw`
(function () {
  if (window.__mempireBridge) return;
  window.__mempireBridge = true;

  var nextId = 1;
  var pending = {};

  function call(kind, payload) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      window.ReactNativeWebView.postMessage(JSON.stringify({
        channel: 'wallet', id: id, kind: kind, payload: payload,
      }));
    });
  }

  /** Native calls this to settle one request. */
  window.__mempireResolve = function (id, ok, result, error) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    if (ok) p.resolve(result); else p.reject(new Error(error || 'wallet request failed'));
  };

  // ── base64 helpers ───────────────────────────────────────────────────────
  // The page and the native side exchange bytes as base64. Neither Buffer nor
  // any bundler helper is reachable here — this runs before the app's scripts.
  function toB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function fromB64(b64) {
    var s = atob(b64);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  var listeners = {};
  function emit(ev) {
    var args = Array.prototype.slice.call(arguments, 1);
    (listeners[ev] || []).forEach(function (fn) { fn.apply(null, args); });
  }

  /**
   * A PublicKey-shaped object rather than the real class.
   *
   * web3.js lives inside the game's bundle and is not reachable from here, so
   * shipping a second copy would mean two PublicKey implementations disagreeing
   * about identity. The adapter only ever calls toBytes / toBase58 / equals on
   * what a provider returns.
   */
  function pubkeyLike(b58) {
    var bytes = null;
    return {
      toBase58: function () { return b58; },
      toString: function () { return b58; },
      equals: function (o) { return (o && o.toBase58 ? o.toBase58() : String(o)) === b58; },
      toBytes: function () { return bytes || (bytes = decodeBase58(b58)); },
      toBuffer: function () { return this.toBytes(); },
    };
  }

  /** Base58 decode. Small enough to inline, and there is nothing to import. */
  function decodeBase58(s) {
    var A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    var bytes = [0];
    for (var i = 0; i < s.length; i++) {
      var v = A.indexOf(s[i]);
      if (v < 0) throw new Error('bad base58');
      for (var j = 0; j < bytes.length; j++) bytes[j] *= 58;
      bytes[0] += v;
      var carry = 0;
      for (var k = 0; k < bytes.length; k++) {
        bytes[k] += carry;
        carry = bytes[k] >> 8;
        bytes[k] &= 0xff;
      }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (var z = 0; z < s.length && s[z] === '1'; z++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }

  /**
   * Serialize whatever the adapter handed us, sign natively, and put the
   * signatures back on the very same object.
   *
   * The adapter keeps a reference to the transaction it passed in and expects
   * the returned one to be it. Rebuilding a fresh Transaction from the signed
   * bytes would satisfy the type and break that expectation, so the signature
   * slots are copied onto the original.
   */
  function signOne(tx) {
    var isVersioned = typeof tx.serializeMessage !== 'function';
    var wire = isVersioned
      ? tx.serialize()
      : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return call('signTransactions', [toB64(new Uint8Array(wire))]).then(function (out) {
      var signed = fromB64(out[0]);
      if (isVersioned) {
        // Versioned: the signature array sits at the front, one 64-byte slot
        // per required signer, after a compact-u16 count.
        var count = signed[0];
        for (var i = 0; i < count; i++) {
          tx.signatures[i] = signed.slice(1 + i * 64, 1 + (i + 1) * 64);
        }
        return tx;
      }
      var n = signed[0];
      for (var j = 0; j < n && j < tx.signatures.length; j++) {
        var sig = signed.slice(1 + j * 64, 1 + (j + 1) * 64);
        var allZero = sig.every(function (b) { return b === 0; });
        if (!allZero) tx.signatures[j].signature = sig;
      }
      return tx;
    });
  }

  var provider = {
    isPhantom: true,
    isMempireNative: true,
    publicKey: null,
    isConnected: false,
    connect: function () {
      return call('connect').then(function (b58) {
        provider.publicKey = pubkeyLike(b58);
        provider.isConnected = true;
        emit('connect', provider.publicKey);
        return { publicKey: provider.publicKey };
      });
    },
    disconnect: function () {
      return call('disconnect').then(function () {
        provider.publicKey = null;
        provider.isConnected = false;
        emit('disconnect');
      });
    },
    signTransaction: function (tx) { return signOne(tx); },
    signAllTransactions: function (txs) {
      // One session, not one per transaction: MWA brings the wallet app to the
      // foreground for each a transact() call, and a deck mint is eight transactions.
      var wires = txs.map(function (t) {
        var v = typeof t.serializeMessage !== 'function';
        return toB64(new Uint8Array(
          v ? t.serialize() : t.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ));
      });
      return call('signTransactions', wires).then(function (out) {
        out.forEach(function (b64, i) {
          var signed = fromB64(b64);
          var n = signed[0];
          var tx = txs[i];
          if (typeof tx.serializeMessage !== 'function') {
            for (var v = 0; v < n; v++) tx.signatures[v] = signed.slice(1 + v * 64, 1 + (v + 1) * 64);
          } else {
            for (var j = 0; j < n && j < tx.signatures.length; j++) {
              var sig = signed.slice(1 + j * 64, 1 + (j + 1) * 64);
              if (!sig.every(function (b) { return b === 0; })) tx.signatures[j].signature = sig;
            }
          }
        });
        return txs;
      });
    },
    signMessage: function (message) {
      return call('signMessages', [toB64(message)]).then(function (out) {
        return { signature: fromB64(out[0]), publicKey: provider.publicKey };
      });
    },
    on: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    off: function (ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter(function (f) { return f !== fn; });
    },
    removeListener: function (ev, fn) { provider.off(ev, fn); },
    removeAllListeners: function () { listeners = {}; },
  };

  window.phantom = { solana: provider };
  window.solana = provider;
  // The adapter requires this flag as well as isPhantom; without it readyState
  // never leaves NotDetected and the picker offers an install link instead of
  // a connect button.
  window.isPhantomInstalled = true;

  // ── the small native surface the game can ask for ────────────────────────
  window.MempireNative = {
    platform: 'android',
    version: 1,
    /**
     * Schedule a local notification.
     *
     * A backgrounded web page cannot wake itself when a chest finishes, which
     * is the whole reason the game wants an app. afterSeconds is relative
     * because the two sides do not share a clock.
     */
    notify: function (title, body, afterSeconds, tag) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        channel: 'notify', title: title, body: body,
        afterSeconds: afterSeconds || 0, tag: tag || null,
      }));
    },
    cancelNotification: function (tag) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ channel: 'cancel', tag: tag }));
    },
    /** Tells the shell the game has painted, so the splash can go. */
    ready: function () {
      window.ReactNativeWebView.postMessage(JSON.stringify({ channel: 'ready' }));
    },
  };

  // If the game never calls ready() — an older build, or a load failure — the
  // splash must not sit there forever.
  window.addEventListener('load', function () {
    setTimeout(function () {
      window.ReactNativeWebView.postMessage(JSON.stringify({ channel: 'ready' }));
    }, 1200);
  });
})();
true;
`;
