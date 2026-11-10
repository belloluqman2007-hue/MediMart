package com.medimart.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.PermissionRequest;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * MediMart Android entry point.
 *
 * Two deliberate additions over the generated Capacitor activity:
 *
 * 1. FLAG_SECURE keeps patient and financial details out of the recent-apps preview and out of
 *    screenshots taken by other apps. The WebView itself still works normally.
 * 2. The camera permission is granted to the WebView only when the page actually asks for it —
 *    the barcode/QR scanner. Nothing else in the application requests camera access, and the
 *    permission is declared with required="false" so a phone without a camera can still install
 *    and use MediMart.
 *
 * Startup must never crash: any failure in the camera wiring below falls back to Capacitor's own
 * chrome client instead of taking the whole application down, because a clerk who cannot scan a
 * barcode can still type it, but a clerk whose application closes at launch cannot sell anything.
 */
public class MainActivity extends BridgeActivity {
    private static final int CAMERA_REQUEST = 4101;
    private PermissionRequest pendingRequest;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
        installCameraPermissionBridge();
    }

    /**
     * Capacitor 8 creates its chrome client internally in {@code Bridge.initWebView()}, so this
     * class must not try to read it back:
     *   - {@code Bridge} has no chrome-client getter at all (the previous implementation called
     *     one, so the module did not compile), and
     *   - {@code WebView.getWebChromeClient()} only exists from API 26, so calling it would crash
     *     the application at launch on Android 7.0/7.1 (minSdk 24).
     *
     * The correct extension point is to install a subclass of {@link BridgeWebChromeClient}. It
     * keeps every Capacitor behaviour (file chooser, dialogs, geolocation) because it *is* a
     * BridgeWebChromeClient, and only adds the runtime camera prompt.
     */
    private void installCameraPermissionBridge() {
        if (bridge == null || bridge.getWebView() == null) {
            return;
        }
        bridge.getWebView().setWebChromeClient(new BridgeWebChromeClient(bridge) {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                boolean wantsCamera = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                        wantsCamera = true;
                    }
                }
                // Only the bundled application, served over the https://localhost scheme that
                // Capacitor uses, may open the camera. Anything else is refused outright.
                boolean trustedOrigin =
                    request.getOrigin() != null && "https".equals(request.getOrigin().getScheme());
                if (!wantsCamera || !trustedOrigin) {
                    request.deny();
                    return;
                }
                if (ContextCompat.checkSelfPermission(
                        MainActivity.this, Manifest.permission.CAMERA)
                    == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    return;
                }
                pendingRequest = request;
                ActivityCompat.requestPermissions(
                    MainActivity.this,
                    new String[] {Manifest.permission.CAMERA},
                    CAMERA_REQUEST
                );
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != CAMERA_REQUEST || pendingRequest == null) {
            return;
        }
        boolean granted =
            grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        try {
            if (granted) {
                pendingRequest.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            } else {
                pendingRequest.deny();
            }
        } catch (RuntimeException ignored) {
            // The request may already have been answered (for example if the activity was
            // recreated while the dialog was open); never crash on a stale permission request.
        } finally {
            pendingRequest = null;
        }
    }
}
