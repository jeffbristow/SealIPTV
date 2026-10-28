/* =====================================================================
 * Seal IPTV for Fire TV — MainActivity.java
 * ---------------------------------------------------------------------
 * The whole app is the Windows app's pages (assets/www) in a full-screen
 * WebView, served from https://appassets.androidplatform.net so the page
 * is a secure origin (Web Crypto for the sync vault).
 *   Back   -> window.__tvBack(); nothing left to go back to: press again to leave
 *   ☰ Menu -> window.__tvMenu() (the right-click menu)
 *   OK     -> window.__tvOk() (form fields: Android's text box + keyboard)
 * Pages: the built-in ones (assets/www), or a newer downloaded version
 * (files/web/<version>, UpdateManager) served as /update/<version>/.
 * Posters / logos: kept in the app's storage the first time (ImageCache),
 * shown from there after that; nothing new is fetched while the VPN guard
 * says no (NativeBridge.blocked) — those requests are refused here.
 * ===================================================================== */
package com.sealiptv.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.util.HashMap;

public class MainActivity extends Activity {
    static volatile String webVersion;   // the pages running now (UpdateManager compares releases with it)
    private WebView web;
    private NativeBridge bridge;
    private ImageCache images;
    private long lastBack = 0;
    private AudioDeviceCallback audioCallback;
    private ConnectivityManager.NetworkCallback netCallback;

    private static final int REQ_VOICE = 41;

    /** voice search (NativeBridge.voiceSearch) */
    void startVoice(String prompt) {
        android.content.Intent i = new android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH);
        i.putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, prompt == null ? "Search" : prompt);
        i.putExtra(android.speech.RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        try { startActivityForResult(i, REQ_VOICE); } catch (Exception e) { if (bridge != null) bridge.voiceBack(null); }
    }

    @Override
    protected void onActivityResult(int req, int result, android.content.Intent data) {
        super.onActivityResult(req, result, data);
        if (req != REQ_VOICE || bridge == null) return;
        java.util.ArrayList<String> said = data == null ? null : data.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS);
        bridge.voiceBack(result == RESULT_OK && said != null && !said.isEmpty() ? said.get(0) : null);
    }

    /** a playlist file of this app's own, by name only (no folders), with its size */
    static WebResourceResponse catalogFile(java.io.File dir, String name) {
        java.io.File f = name == null || !name.matches("[\\w.-]+\\.json") ? null : new java.io.File(dir, name);
        HashMap<String, String> h = new HashMap<>();
        try {
            if (f == null || !f.isFile()) return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", h, new ByteArrayInputStream(new byte[0]));
            h.put("Content-Length", String.valueOf(f.length()));
            h.put("Cache-Control", "no-store");
            return new WebResourceResponse("application/json", "utf-8", 200, "OK", h, new java.io.BufferedInputStream(new java.io.FileInputStream(f), 1 << 16));
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 500, "Error", h, new ByteArrayInputStream(new byte[0]));
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#121418"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);
        // the page is laid out 1280 px wide (index.html); scale it so exactly that fills the TV,
        // whatever the screen (1080p Fire TV = 1.5x, 720p = 1x, 4K = 3x) — no sideways scrolling
        DisplayMetrics dm = getResources().getDisplayMetrics();
        web.setInitialScale(Math.max(50, Math.round(Math.max(dm.widthPixels, dm.heightPixels) * 100f / 1280f)));
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);   // providers' posters are often http://
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        images = new ImageCache(this);
        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/update/", new WebViewAssetLoader.InternalStoragePathHandler(this, UpdateManager.webDir(this))).build();
        final java.io.File catalogDir = new java.io.File(getFilesDir(), "data/catalog");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) {
                    // the saved playlists, read by fetch() at start-up: much faster than through the bridge (core.js)
                    if (u.getPath() != null && u.getPath().startsWith("/catalog/")) return catalogFile(catalogDir, u.getLastPathSegment());
                    return assets.shouldInterceptRequest(u);
                }
                boolean image = isImage(req);
                if (image) {
                    WebResourceResponse kept = images.kept(u.toString());
                    if (kept != null) return kept;
                }
                if (bridge != null && bridge.blocked) {
                    return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked: VPN is off", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
                }
                return image ? images.get(u.toString(), bridge != null ? bridge.guardUa : null) : null;   // null: the WebView loads it
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return true;   // never navigate away from the app
            }
        });
        bridge = new NativeBridge(this, web);
        web.addJavascriptInterface(bridge, "SealNative");
        String downloaded = UpdateManager.pickWeb(this);
        webVersion = downloaded != null ? downloaded : UpdateManager.builtInWebVersion(this);
        web.loadUrl(downloaded != null
                ? "https://appassets.androidplatform.net/update/" + downloaded + "/index.html"
                : "https://appassets.androidplatform.net/assets/www/index.html");
        web.requestFocus();

        watchNetwork();
        watchAudio();
    }

    /** a picture the page shows (<img>, CSS background): GET from the web, Accept: image/… */
    private static boolean isImage(WebResourceRequest req) {
        String s = req.getUrl().getScheme();
        if (!"GET".equals(req.getMethod()) || !("http".equals(s) || "https".equals(s))) return false;
        for (java.util.Map.Entry<String, String> h : req.getRequestHeaders().entrySet()) {
            if ("accept".equalsIgnoreCase(h.getKey())) return h.getValue() != null && h.getValue().startsWith("image/");
        }
        return false;
    }

    /* VPN up / down, Wi-Fi changes -> 'network' (core.js checks the VPN again) */
    private void watchNetwork() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) { bridge.emit("network", "{}"); }
            @Override public void onLost(Network n) { bridge.emit("network", "{}"); }
            @Override public void onCapabilitiesChanged(Network n, NetworkCapabilities c) { bridge.emit("network", "{}"); }
        };
        try {
            cm.registerNetworkCallback(new NetworkRequest.Builder().removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(), netCallback);
        } catch (Exception ignored) { }
    }

    /* Bluetooth headphones on / off -> 'audio' (audio sync follows the device) */
    private void watchAudio() {
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        audioCallback = new AudioDeviceCallback() {
            @Override public void onAudioDevicesAdded(AudioDeviceInfo[] d) { bridge.emit("audio", "{}"); }
            @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] d) { bridge.emit("audio", "{}"); }
        };
        am.registerAudioDeviceCallback(audioCallback, new Handler(Looper.getMainLooper()));
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if (k == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP) {
                web.evaluateJavascript("String(window.__tvBack ? window.__tvBack() : false)", v -> {
                    if (!"\"false\"".equals(v)) return;
                    long now = System.currentTimeMillis();
                    if (now - lastBack < 2500) finish();
                    else { lastBack = now; Toast.makeText(this, "Press Back again to leave Seal IPTV", Toast.LENGTH_SHORT).show(); }
                });
            }
            return true;
        }
        if (k == KeyEvent.KEYCODE_SEARCH) {   // the remote's search key: voice search (or the text box)
            if (e.getAction() == KeyEvent.ACTION_UP) web.evaluateJavascript("window.__tvSearchKey && window.__tvSearchKey()", null);
            return true;
        }
        if (k == KeyEvent.KEYCODE_MENU) {
            if (e.getAction() == KeyEvent.ACTION_UP) web.evaluateJavascript("window.__tvMenu && window.__tvMenu()", null);
            return true;
        }
        if (k == KeyEvent.KEYCODE_DPAD_CENTER) {
            // OK: tvnav.js presses the selected thing, or opens the keyboard on a form field
            // (not sent as Enter: Enter in a text box would submit it instead of letting you type)
            if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) {
                web.evaluateJavascript("String(window.__tvOk ? window.__tvOk() : false)", v -> {
                    if ("\"false\"".equals(v)) {
                        long t = SystemClock.uptimeMillis();
                        web.dispatchKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0));
                        web.dispatchKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER, 0));
                    }
                });
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override protected void onResume() { super.onResume(); if (bridge != null) bridge.emit("resume", "{}"); web.onResume(); }
    @Override protected void onPause() { if (bridge != null) bridge.emit("pause", "{}"); super.onPause(); }

    @Override
    protected void onDestroy() {
        try { ((ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE)).unregisterNetworkCallback(netCallback); } catch (Exception ignored) { }
        try { ((AudioManager) getSystemService(AUDIO_SERVICE)).unregisterAudioDeviceCallback(audioCallback); } catch (Exception ignored) { }
        if (bridge != null) bridge.close();   // also on "restart" after an update (recreate)
        web.destroy();
        super.onDestroy();
    }

    @Override public void onWindowFocusChanged(boolean has) {
        super.onWindowFocusChanged(has);
        if (has) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }
}
