import type { CapacitorConfig } from '@capacitor/cli';
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
  android: { allowMixedContent: developmentHttp, minWebViewVersion: 110 },
  plugins: {
    CapacitorSQLite: {
      androidIsEncryption: true,
      androidBiometric: { biometricAuth: false, biometricTitle: 'MediMart' },
    },
  },
};
export default config;
