import 'react-native-get-random-values';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, BackHandler, Linking, Platform,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { INJECTED_BRIDGE } from './src/injected';
import { handle, type BridgeRequest } from './src/walletBridge';

/**
 * Mempire, as an Android app.
 *
 * # Why a WebView and not a rewrite
 *
 * The game is a WebGL arena — React Three Fiber, instanced meshes, a
 * deterministic fixed-point simulation — sitting under a full DOM interface.
 * Rebuilding that natively would take months and produce a *second*
 * implementation of a simulation whose entire correctness argument is that both
 * players run the same one. A divergent native sim would desync against every
 * web opponent, which is the one bug this architecture cannot tolerate.
 *
 * So the game is the game, and this is a real Android shell around it: a native
 * wallet path that a browser cannot have, notifications a backgrounded web page
 * cannot schedule, an app icon, a splash, deep links, and hardware back.
 *
 * # What the shell actually adds
 *
 * - **Mobile Wallet Adapter.** On Android there is no wallet extension. Without
 *   this the game could only ever offer Guest play, which is the difference
 *   between a demo and an app that can hold a stake.
 * - **Notifications with the game's own sound.** A chest finishing is the one
 *   event worth interrupting someone for.
 * - **Back that means back.** Android's back button navigating the WebView
 *   rather than killing the app.
 */

const GAME_URL = 'https://play.mempire.fun';

/** Foreground notifications still play the sound — the chest chime is the point. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

void SplashScreen.preventAutoHideAsync();

/**
 * Android puts the sound on the *channel*, not the notification.
 *
 * A channel's sound is fixed when it is created and cannot be changed
 * afterwards — the OS ignores an update. So the id carries a version: shipping
 * a new chime means bumping it, otherwise everyone who already installed the
 * app keeps hearing the old one forever.
 */
const CHANNEL_ID = 'mempire-v1';

async function ensureChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Mempire',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'mempire_chime.wav',
    vibrationPattern: [0, 120, 80, 120],
    lightColor: '#FFC422',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

export default function App() {
  const webRef = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const canGoBack = useRef(false);

  useEffect(() => {
    void (async () => {
      await ensureChannel();
      // Asked for once, on a real device. An emulator has no notification
      // surface worth prompting about and the request just fails.
      if (Device.isDevice) {
        const { status } = await Notifications.getPermissionsAsync();
        if (status !== 'granted') await Notifications.requestPermissionsAsync();
      }
    })();
  }, []);

  // Android back navigates the game rather than closing the app — the tab bar
  // is inside the WebView, so without this every back press is an exit.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack.current) {
        webRef.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  // A match runs on a socket. Coming back from the background after the socket
  // died leaves a screen that looks live and is not, so the page is told to
  // re-check rather than left to discover it mid-match.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        webRef.current?.injectJavaScript(
          'window.dispatchEvent(new Event("mempire-resumed")); true;',
        );
      }
    });
    return () => sub.remove();
  }, []);

  const reply = useCallback((id: number, ok: boolean, result?: unknown, error?: string) => {
    const payload = JSON.stringify(result ?? null);
    webRef.current?.injectJavaScript(
      `window.__mempireResolve(${id}, ${ok}, ${payload}, ${JSON.stringify(error ?? null)}); true;`,
    );
  }, []);

  const onMessage = useCallback(async (e: WebViewMessageEvent) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return; // not ours — the page posts other things
    }

    switch (msg.channel) {
      case 'ready':
        setReady(true);
        void SplashScreen.hideAsync();
        return;

      case 'wallet': {
        const res = await handle(msg as unknown as BridgeRequest);
        reply(res.id, res.ok, res.result, res.error);
        return;
      }

      case 'notify': {
        const after = Math.max(0, Number(msg.afterSeconds) || 0);
        await Notifications.scheduleNotificationAsync({
          identifier: typeof msg.tag === 'string' ? msg.tag : undefined,
          content: {
            title: String(msg.title ?? 'Mempire'),
            body: String(msg.body ?? ''),
            sound: 'mempire_chime.wav',
          },
          trigger: after > 0
            ? {
              type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
              seconds: after,
              channelId: CHANNEL_ID,
            }
            : null,
        });
        return;
      }

      case 'cancel': {
        if (typeof msg.tag === 'string') {
          await Notifications.cancelScheduledNotificationAsync(msg.tag);
        }
        return;
      }

      default:
    }
  }, [reply]);

  if (failed) {
    return (
      <View style={styles.fill}>
        <StatusBar style="light" />
        <Text style={styles.title}>MEMPIRE</Text>
        <Text style={styles.body}>
          Could not reach the arena. Check your connection and try again.
        </Text>
        <Text style={styles.fine}>{failed}</Text>
        <TouchableOpacity
          style={styles.button}
          onPress={() => { setFailed(null); webRef.current?.reload(); }}
        >
          <Text style={styles.buttonText}>RETRY</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <StatusBar style="light" />
      <WebView
        ref={webRef}
        source={{ uri: GAME_URL }}
        // Before the page's own scripts, so the wallet provider exists by the
        // time the adapter looks for one.
        injectedJavaScriptBeforeContentLoaded={INJECTED_BRIDGE}
        onMessage={onMessage}
        onNavigationStateChange={(nav) => { canGoBack.current = nav.canGoBack; }}
        onError={(e) => setFailed(e.nativeEvent.description)}
        onHttpError={(e) => {
          // A 404 on a sub-resource is not a dead app; only the document is.
          if (e.nativeEvent.url === GAME_URL) setFailed(`server returned ${e.nativeEvent.statusCode}`);
        }}
        // The arena is WebGL and the sim runs on a timer. Without these the
        // canvas falls back to software rendering and the game is a slideshow.
        renderToHardwareTextureAndroid
        androidLayerType="hardware"
        javaScriptEnabled
        domStorageEnabled
        // Guest identity lives in localStorage; clearing it would sign the
        // player out every launch.
        thirdPartyCookiesEnabled
        // A game is not a document: bounce and long-press selection both read
        // as bugs inside a canvas.
        bounces={false}
        overScrollMode="never"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        setSupportMultipleWindows={false}
        // Wallet apps and the explorer open outside; everything else stays in.
        onShouldStartLoadWithRequest={(r) => {
          if (r.url.startsWith(GAME_URL) || r.url.startsWith('about:')) return true;
          if (/^(https?|solana|phantom|intent):/.test(r.url)) {
            void Linking.openURL(r.url).catch(() => {});
            return false;
          }
          return false;
        }}
        style={styles.fill}
      />
      {!ready && (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator size="large" color="#ffc422" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#0d2a5c' },
  loading: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0d2a5c',
  },
  title: {
    color: '#ffc422', fontSize: 34, fontWeight: '900', letterSpacing: 2,
    textAlign: 'center', marginTop: 'auto',
  },
  body: {
    color: '#dbe8ff', fontSize: 15, textAlign: 'center',
    paddingHorizontal: 34, marginTop: 12,
  },
  fine: {
    color: '#7c8db5', fontSize: 12, textAlign: 'center',
    paddingHorizontal: 34, marginTop: 8, marginBottom: 'auto',
  },
  button: {
    backgroundColor: '#f5b423', borderRadius: 12, paddingVertical: 14,
    marginHorizontal: 40, marginBottom: 60, alignItems: 'center',
  },
  buttonText: { color: '#10203f', fontWeight: '900', fontSize: 16, letterSpacing: 1 },
});
