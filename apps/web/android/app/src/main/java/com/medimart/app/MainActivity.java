package com.medimart.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;

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

        // BridgeWebChromeClient already routes getUserMedia to Android; wrap it so the runtime
        // permission is requested explicitly instead of failing silently.
        WebChromeClient chrome = bridge.getWebChromeClient();
        if (chrome instanceof BridgeWebChromeClient) {
            bridge.getWebView().setWebChromeClient(new BridgeWebChromeClient(bridge) {
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    boolean wantsCamera = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            wantsCamera = true;
                        }
                    }
                    if (!wantsCamera || !request.getOrigin().getScheme().equals("https")) {
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
        if (granted) {
            pendingRequest.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            pendingRequest.deny();
        }
        pendingRequest = null;
    }
}
