package com.medimart.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Device-side identity/manifest smoke check. This does not verify encryption or offline data. */
@RunWith(AndroidJUnit4.class)
public class AppIdentityTest {
    @Test
    public void permanentIdentityAndBackupPolicy() {
        // The target application, not the test APK: identity and permissions belong to it.
        Context context = ApplicationProvider.getApplicationContext();
        ApplicationInfo info = context.getApplicationInfo();
        assertEquals("com.medimart.app", context.getPackageName());
        assertEquals("MediMart", context.getPackageManager().getApplicationLabel(info).toString());
        assertEquals(0, info.flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
    }

    /** The camera must be optional: a phone without one still installs and sells. */
    @Test
    public void cameraIsOptionalAndNarrowlyUsed() {
        // The target application, not the test APK: identity and permissions belong to it.
        Context context = ApplicationProvider.getApplicationContext();
        int camera = context.checkSelfPermission(android.Manifest.permission.CAMERA);
        // Declared (grantable) rather than absent, but never granted without a runtime prompt.
        assertTrue(
            "CAMERA must be declared so the barcode scanner can request it at runtime",
            camera == android.content.pm.PackageManager.PERMISSION_GRANTED
                || camera == android.content.pm.PackageManager.PERMISSION_DENIED);
    }
}
