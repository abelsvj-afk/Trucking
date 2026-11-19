package com.truckingos.tracker;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * The drive map inside the Tracker app (owner 2026-11-19: "the map has to be
 * not only in app, but in the tracking app as well ... so the map can actually
 * be used for real while I'm driving").
 *
 * - Shows the app's own live drive map (server address saved in Settings +
 *   /smart-path/drive) — one map, the same code as in the browser, not a copy.
 * - Keeps the screen ON while it is open (FLAG_KEEP_SCREEN_ON): a native
 *   guarantee that does not depend on the browser's wake lock.
 * - Leaving it (home button, another app) shrinks it to Android's
 *   picture-in-picture window: a small floating map the driver can DRAG
 *   anywhere and pinch to resize — the system owns the window, so it never
 *   gets stuck in a corner. Tapping it brings the full map back.
 * - Only the saved server is ever loaded: a link anywhere else is refused
 *   (untrusted pages never run inside it).
 */
public class MapActivity extends Activity {
    private static final int REQ_MIC = 41;
    private WebView web;
    private String serverHost;
    private PermissionRequest pendingMic;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        String server = TrackerService.prefs(this).getString("server", "");
        web = new WebView(this);
        setContentView(web);
        if (server.isEmpty()) {
            web.loadData(MapScreen.noServerHtml(), "text/html", "utf-8");
            return;
        }
        serverHost = Uri.parse(server).getHost();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setGeolocationEnabled(true);
        // Spoken turn and hazard calls must play without a tap first.
        s.setMediaPlaybackRequiresUserGesture(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !MapScreen.isOwnServer(request.getUrl().getHost(), serverHost);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                boolean own = MapScreen.isOwnServer(Uri.parse(origin).getHost(), serverHost);
                callback.invoke(origin, own, false);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // The microphone, for voice notes — only for the app's own pages.
                if (!MapScreen.isOwnServer(request.getOrigin().getHost(), serverHost)) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    pendingMic = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                }
            }
        });
        web.loadUrl(MapScreen.mapUrl(server));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_MIC || pendingMic == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pendingMic.deny();
        }
        pendingMic = null;
    }

    /** Leaving the map while driving: float it small instead of closing it. */
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && web != null && serverHost != null) {
            try {
                enterPictureInPictureMode(new PictureInPictureParams.Builder()
                        .setAspectRatio(new Rational(3, 4))
                        .build());
            } catch (IllegalStateException e) {
                // Picture-in-picture switched off for this app in the phone's settings: the map just closes.
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
