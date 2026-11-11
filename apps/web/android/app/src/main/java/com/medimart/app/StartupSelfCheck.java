package com.medimart.app;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.util.Log;
import android.webkit.WebView;
import java.security.KeyStore;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Startup self-check for the two native systems the encrypted database depends on.
 *
 * This exists because of a real support situation: an installed MediMart on Android 8.1 refused to
 * start and the only visible message was "could not initialize its secure database". From
 * JavaScript that message cannot distinguish between
 *
 *   - the Android Keystore being unusable on the device (a Keystore key that cannot be read, or a
 *     Keymaster that fails to generate one) — the SQLite plugin swallows that failure inside
 *     {@code load()} and then answers every call with "CapacitorSQLitePlugin: null", and
 *   - the SQLCipher native library not loading at all (ABI/packaging), and
 *   - a database file that exists but cannot be opened with the stored key.
 *
 * The check below answers the first two questions in logcat *before* the WebView runs, using only
 * operations that cannot damage anything:
 *
 *   - {@code AndroidKeyStore} is loaded, and a dedicated probe key (its own alias, never the SQLite
 *     plugin's key and never the database passphrase) is used to encrypt and decrypt a fixed,
 *     public test string. If Keystore generation or ciphering is broken on the device, this is the
 *     line that says so.
 *   - {@code System.loadLibrary("sqlcipher")} is attempted, which proves the native library for the
 *     device ABI is present in the APK.
 *
 * Nothing secret is logged: the probe key is generated inside the Keystore and never exported, the
 * plaintext is the constant below, and no passphrase or database content is read.
 *
 * A failure here is **logged, not fatal**: JavaScript owns the fail-closed decision and shows the
 * diagnostic code. This class must never be able to crash startup.
 */
final class StartupSelfCheck {

    /** Logcat tag; the CI emulator script greps for it. */
    static final String TAG = "MediMartStartup";
    static final String OK = "self-check ok";
    static final String FAILED = "self-check failed";
    private static final String PROBE_ALIAS = "medimart_startup_probe";
    private static final String PROBE_TEXT = "medimart-keystore-probe";

    private StartupSelfCheck() {}

    static void run(Context context) {
        logEnvironment(context);
        boolean keystore = checkKeystore();
        boolean sqlcipher = checkSqlcipher();
        if (keystore && sqlcipher) {
            Log.i(TAG, OK + " keystore=ok sqlcipher=ok");
        } else {
            Log.e(
                TAG,
                FAILED
                    + " keystore="
                    + (keystore ? "ok" : "FAILED")
                    + " sqlcipher="
                    + (sqlcipher ? "ok" : "FAILED")
            );
        }
    }

    private static void logEnvironment(Context context) {
        String webView = "unknown";
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                PackageInfo info = WebView.getCurrentWebViewPackage();
                if (info != null) webView = info.packageName + " " + info.versionName;
            }
        } catch (Throwable ignored) {
            // Only diagnostic detail; never allow it to affect startup.
        }
        Log.i(
            TAG,
            "environment sdk="
                + Build.VERSION.SDK_INT
                + " release="
                + Build.VERSION.RELEASE
                + " device="
                + Build.MANUFACTURER
                + " "
                + Build.MODEL
                + " app="
                + context.getPackageName()
                + " webview="
                + webView
        );
    }

    /**
     * Generate (or reuse) a probe key and round-trip a public constant through AES/GCM.
     *
     * The probe alias is deliberately different from the SQLite plugin's master key
     * ({@code _androidx_security_master_key_}) and from the secure-storage plugin's per-key aliases,
     * so a failure here is not caused by, and cannot damage, their key material.
     */
    /** Package-private so the device test can assert it directly on the emulator. */
    static boolean checkKeystore() {
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            SecretKey key = getOrCreateProbeKey();
            if (key == null) {
                Log.e(TAG, "keystore failed: probe key could not be created");
                return false;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal(PROBE_TEXT.getBytes("UTF-8"));
            Cipher decrypt = Cipher.getInstance("AES/GCM/NoPadding");
            decrypt.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            String roundTrip = new String(decrypt.doFinal(encrypted), "UTF-8");
            if (!PROBE_TEXT.equals(roundTrip)) {
                Log.e(TAG, "keystore failed: probe round-trip mismatch");
                return false;
            }
            return true;
        } catch (Throwable error) {
            Log.e(TAG, "keystore failed: " + describe(error));
            return false;
        }
    }

    private static SecretKey getOrCreateProbeKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(PROBE_ALIAS)) {
            KeyStore.Entry entry = keyStore.getEntry(PROBE_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
            // An entry of another type under this alias is unusable; say so instead of guessing.
            throw new IllegalStateException("probe alias holds a non-secret entry");
        }
        KeyGenerator generator = KeyGenerator.getInstance("AES", "AndroidKeyStore");
        android.security.keystore.KeyGenParameterSpec.Builder builder =
            new android.security.keystore.KeyGenParameterSpec.Builder(
                PROBE_ALIAS,
                android.security.keystore.KeyProperties.PURPOSE_ENCRYPT
                    | android.security.keystore.KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256);
        // A device with a broken random source must fail loudly here, not silently produce a key.
        generator.init(builder.build(), new SecureRandom());
        return generator.generateKey();
    }

    /** Prove the SQLCipher native library for this device's ABI is packaged and loadable. */
    /** Package-private so the device test can assert it directly on the emulator. */
    static boolean checkSqlcipher() {
        try {
            System.loadLibrary("sqlcipher");
            return true;
        } catch (Throwable error) {
            Log.e(TAG, "sqlcipher failed: " + describe(error));
            return false;
        }
    }

    /** Exception class plus message. Never includes key material: this class holds none. */
    private static String describe(Throwable error) {
        String message = error.getMessage();
        return error.getClass().getName() + (message == null ? "" : ": " + message);
    }
}
