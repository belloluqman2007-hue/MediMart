package com.medimart.app;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Device-side compatibility check for the two native systems the encrypted database depends on.
 *
 * This is the test that answers "does Android 8.1 support what the secure database needs?" on the
 * emulator itself, with no WebView and no network:
 *
 * - Android Keystore must generate an AES-256/GCM key and round-trip data through it. The SQLite
 *   plugin creates its master key with exactly that scheme; if the Keystore cannot do this, the
 *   plugin fails inside its `load()` and every later call returns "CapacitorSQLitePlugin: null".
 * - The SQLCipher shared library must load for the device ABI.
 *
 * Run on a specific API level:
 *   ./gradlew connectedDebugAndroidTest        (with an emulator/phone attached)
 */
public class SecureStorageCompatibilityTest {

    @Test
    public void androidKeystoreGeneratesAndUsesAesGcmKeys() {
        assertTrue(
            "Android Keystore could not generate and use an AES-256/GCM key on this device. "
                + "The encrypted database cannot be initialized without it.",
            StartupSelfCheck.checkKeystore()
        );
    }

    @Test
    public void sqlcipherNativeLibraryLoadsForThisAbi() {
        assertTrue(
            "The SQLCipher native library did not load for this device ABI.",
            StartupSelfCheck.checkSqlcipher()
        );
    }
}
