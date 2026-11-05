package com.medimart.app;

import static org.junit.Assert.assertEquals;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Device-side identity/manifest smoke check. This does not verify encryption or offline data. */
@RunWith(AndroidJUnit4.class)
public class AppIdentityTest {
    @Test
    public void permanentIdentityAndBackupPolicy() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ApplicationInfo info = context.getApplicationInfo();
        assertEquals("com.medimart.app", context.getPackageName());
        assertEquals("MediMart", context.getPackageManager().getApplicationLabel(info).toString());
        assertEquals(0, info.flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
    }
}
