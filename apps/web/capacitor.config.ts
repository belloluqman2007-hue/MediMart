import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Debug ("native-development") builds talk to the shop computer over plain HTTP on a private
 * Wi-Fi network, because a shop without internet cannot obtain a certificate. Two Android
 * mechanisms must both allow it or the WebView blocks the request before it leaves the phone:
 *   1. Capacitor's WebView mixed-content mode (below), and
 *   2. the manifest / network security config (see app/src/debug).
 * Release builds keep both off and are TLS-only.
 */
const developmentHttp = process.env.MEDIMART_ANDROID_DEV_HTTP === 'true';

const config: CapacitorConfig = {
  appId: 'com.medimart.app',
  appName: 'MediMart',
  webDir: 'dist',
  // No server.url: the APK ALWAYS opens its locally bundled application.
  server: {
    androidScheme: 'https',
    cleartext: developmentHttp,
    errorPath: 'unsupported-webview.html',
  },
  android: {
    // The WebView origin is https://localhost; an http:// API on the LAN is mixed content.
    allowMixedContent: developmentHttp,
    // Vite targets ES2022. The oldest WebView API the application actually uses is
    // AbortSignal.timeout (Chromium 103, July 2022) plus crypto.randomUUID (92). 104 is therefore
    // the honest floor: a phone with anything older gets the bundled explanation page instead of a
    // half-working screen, and a phone that was already supported keeps working.
    minWebViewVersion: 104,
  },
  plugins: {
    CapacitorSQLite: {
      androidIsEncryption: true,
      androidBiometric: { biometricAuth: false, biometricTitle: 'MediMart' },
    },
  },
};

export default config;
