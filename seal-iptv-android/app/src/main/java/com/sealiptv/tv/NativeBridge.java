/* =====================================================================
 * Seal IPTV for Fire TV — NativeBridge.java   (window.SealNative)
 * ---------------------------------------------------------------------
 * What the web part (core.js / player-tv.js) needs from Android:
 *   files      readFile / writeFile / renameFile / deleteFile / exists
 *              (the app's private storage, files/data/…)
 *   Keystore   encrypt / decrypt (playlist passwords, the sync vault key)
 *   web        request(id, json) -> done later: window.__nativeDone(id),
 *              then take(id) gives the answer (no CORS, any User-Agent)
 *   network    interfaces(), vpnActive() (Android's own "a VPN is on")
 *   sound      audioOutput() — the audio device's name, for audio sync
 *   apps       launchApp(package), openExternal(url, title, ua)
 *   player     play(json), playerCommand(json)   (PlayerActivity)
 *   guard      setGuard(blocked, ua): posters / logos while the VPN is off
 *   updates    updateCheck(id) / updateInstall(id) (async like request),
 *              updateRestart(), webReady() — UpdateManager
 * Events back to the web part: emit(name, json) -> window.__nativeEvent.
 * ===================================================================== */
package com.sealiptv.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.text.InputType;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.EditText;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class NativeBridge {
    static NativeBridge current;

    private final Activity activity;
    private final WebView web;
    private final File root;
    private final ExecutorService pool = Executors.newFixedThreadPool(6);
    private final Map<String, String> answers = new ConcurrentHashMap<>();
    private UpdateManager updates;
    volatile boolean blocked = false;
    volatile String guardUa = null;

    NativeBridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        this.root = new File(activity.getFilesDir(), "data");
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        current = this;
    }

    /* ---------------- events to the web part ---------------- */
    void emit(String name, String json) {
        final String js = "window.__nativeEvent && window.__nativeEvent(" + JSONObject.quote(name) + "," + JSONObject.quote(json == null ? "{}" : json) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    /* ---------------- files ---------------- */
    private File file(String path) {
        String p = path == null ? "" : path.replace('\\', '/');
        if (p.startsWith("/data/")) p = p.substring(6); else if (p.startsWith("/")) p = p.substring(1);
        for (String part : p.split("/")) if (part.equals("..")) throw new SecurityException("bad path");
        return new File(root, p);
    }

    @JavascriptInterface public String readFile(String path) {
        try {
            File f = file(path);
            if (!f.isFile()) return null;
            try (InputStream in = new java.io.FileInputStream(f)) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream((int) Math.max(1024, f.length()));
                byte[] b = new byte[65536];
                int n;
                while ((n = in.read(b)) > 0) buf.write(b, 0, n);
                return buf.toString("UTF-8");
            }
        } catch (Exception e) { return null; }
    }

    @JavascriptInterface public boolean writeFile(String path, String text) {
        try {
            File f = file(path);
            File dir = f.getParentFile();
            if (dir != null) //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
            try (OutputStream o = new FileOutputStream(f)) { o.write(text.getBytes(StandardCharsets.UTF_8)); }
            return true;
        } catch (Exception e) { return false; }
    }

    @JavascriptInterface public boolean renameFile(String from, String to) {
        try {
            File a = file(from), b = file(to);
            if (!a.exists()) return false;
            if (b.exists()) //noinspection ResultOfMethodCallIgnored
                b.delete();
            return a.renameTo(b);
        } catch (Exception e) { return false; }
    }

    @JavascriptInterface public boolean deleteFile(String path) {
        try { File f = file(path); return f.exists() && f.delete(); } catch (Exception e) { return false; }
    }

    @JavascriptInterface public boolean exists(String path) {
        try { return file(path).exists(); } catch (Exception e) { return false; }
    }

    /* ---------------- Keystore (AES-GCM, key never leaves Android) ---------------- */
    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias("sealiptv")) return ((KeyStore.SecretKeyEntry) ks.getEntry("sealiptv", null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder("sealiptv", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
        return g.generateKey();
    }

    @JavascriptInterface public synchronized String encrypt(String text) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV(), ct = c.doFinal(text.getBytes(StandardCharsets.UTF_8));
            byte[] all = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, all, 0, iv.length);
            System.arraycopy(ct, 0, all, iv.length, ct.length);
            return Base64.encodeToString(all, Base64.NO_WRAP);
        } catch (Exception e) { throw new RuntimeException("Keystore: " + e.getMessage()); }
    }

    @JavascriptInterface public synchronized String decrypt(String b64) {
        try {
            byte[] all = Base64.decode(b64, Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
            return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
        } catch (Exception e) { return null; }
    }

    /* ---------------- web requests (async) ---------------- */
    @JavascriptInterface public void request(final String id, final String json) {
        pool.execute(() -> {
            String answer;
            try { answer = doRequest(new JSONObject(json)).toString(); }
            catch (Exception e) { answer = "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}"; }
            answers.put(id, answer);
            web.post(() -> web.evaluateJavascript("window.__nativeDone && window.__nativeDone(" + JSONObject.quote(id) + ")", null));
        });
    }

    @JavascriptInterface public String take(String id) { String a = answers.remove(id); return a == null ? "{\"ok\":false,\"error\":\"no answer\"}" : a; }

    private JSONObject doRequest(JSONObject o) throws Exception {
        String url = o.getString("url");
        String method = o.optString("method", "GET");
        int timeout = o.optInt("timeout", 30000);
        boolean follow = !"error".equals(o.optString("redirect", "follow"));
        JSONObject headers = o.optJSONObject("headers");
        String body = o.isNull("body") ? null : o.optString("body", null);
        JSONObject out = new JSONObject();
        try {
            for (int hop = 0; hop < 6; hop++) {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(Math.min(timeout, 15000));
                c.setReadTimeout(timeout);
                c.setRequestMethod(method);
                if (headers != null) for (Iterator<String> it = headers.keys(); it.hasNext(); ) { String k = it.next(); c.setRequestProperty(k, headers.getString(k)); }
                if (body != null && !method.equals("GET")) {
                    c.setDoOutput(true);
                    try (OutputStream os = c.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }
                }
                int status = c.getResponseCode();
                if (status >= 300 && status < 400 && c.getHeaderField("Location") != null) {
                    if (!follow) { out.put("ok", false); out.put("error", "redirected"); return out; }
                    url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                    c.disconnect();
                    if (status == 303) { method = "GET"; body = null; }
                    continue;
                }
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                String text = "";
                if (in != null) {
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    byte[] b = new byte[65536];
                    int n;
                    while ((n = in.read(b)) > 0) buf.write(b, 0, n);
                    in.close();
                    text = buf.toString(charsetOf(c.getContentType()).name());
                }
                JSONObject h = new JSONObject();
                for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) if (e.getKey() != null && !e.getValue().isEmpty()) h.put(e.getKey(), e.getValue().get(0));
                out.put("ok", true); out.put("status", status); out.put("url", url); out.put("headers", h); out.put("body", text);
                c.disconnect();
                return out;
            }
            out.put("ok", false); out.put("error", "too many redirects");
        } catch (UnknownHostException e) { out.put("ok", false); out.put("error", "host not found"); out.put("code", "ENOTFOUND"); }
        catch (ConnectException e) { out.put("ok", false); out.put("error", "connection refused"); out.put("code", "ECONNREFUSED"); }
        catch (SocketTimeoutException e) { out.put("ok", false); out.put("error", "timed out"); out.put("code", "ETIMEDOUT"); }
        catch (javax.net.ssl.SSLException e) { out.put("ok", false); out.put("error", "secure connection failed: " + e.getMessage()); out.put("code", "ESSL"); }
        return out;
    }

    private static Charset charsetOf(String type) {
        try {
            if (type != null) for (String part : type.split(";")) { part = part.trim(); if (part.toLowerCase().startsWith("charset=")) return Charset.forName(part.substring(8).replace("\"", "")); }
        } catch (Exception ignored) { }
        return StandardCharsets.UTF_8;
    }

    /* ---------------- network ---------------- */
    @JavascriptInterface public String interfaces() {
        JSONObject out = new JSONObject();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp()) continue;
                JSONArray list = new JSONArray();
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    JSONObject x = new JSONObject();
                    x.put("address", a.getHostAddress().replaceAll("%.*$", ""));
                    x.put("family", a.getAddress().length == 4 ? "IPv4" : "IPv6");
                    x.put("internal", a.isLoopbackAddress());
                    list.put(x);
                }
                if (list.length() > 0) out.put(ni.getName(), list);
            }
        } catch (Exception ignored) { }
        return out.toString();
    }

    /** "Android VPN (tun0)" while a VPN app (ProtonVPN) has a connection up, else null. */
    @JavascriptInterface public String vpnActive() {
        try {
            ConnectivityManager cm = (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                    LinkProperties lp = cm.getLinkProperties(n);
                    String name = lp != null ? lp.getInterfaceName() : null;
                    return "Android VPN" + (name != null ? " (" + name + ")" : "");
                }
            }
        } catch (Exception ignored) { }
        return null;
    }

    /* ---------------- sound ---------------- */
    /** The output the sound goes to: Bluetooth first, then USB, HDMI (the TV). */
    @JavascriptInterface public String audioOutput() { return audioOutputName(activity); }

    static String audioOutputName(Context ctx) {
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            AudioDeviceInfo best = null;
            int bestRank = 99;
            for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                int r = rank(d.getType());
                if (r < bestRank) { bestRank = r; best = d; }
            }
            if (best == null) return "TV speakers";
            String name = best.getProductName() == null ? "" : best.getProductName().toString().trim();
            String kind = bestRank <= 1 ? "Bluetooth" : bestRank == 2 ? "USB" : bestRank <= 4 ? "HDMI" : "speakers";
            if (name.isEmpty() || name.equals(Build.MODEL)) return kind.equals("HDMI") ? "TV (HDMI)" : kind;
            return name + " (" + kind + ")";
        } catch (Exception e) { return ""; }
    }

    private static int rank(int t) {
        if (t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP) return 0;
        if (Build.VERSION.SDK_INT >= 31 && (t == 26 /* BLE_HEADSET */ || t == 27 /* BLE_SPEAKER */)) return 1;
        if (t == AudioDeviceInfo.TYPE_USB_DEVICE || t == AudioDeviceInfo.TYPE_USB_HEADSET) return 2;
        if (t == AudioDeviceInfo.TYPE_HDMI_ARC || t == 29 /* HDMI_EARC */) return 3;
        if (t == AudioDeviceInfo.TYPE_HDMI) return 4;
        if (t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || t == AudioDeviceInfo.TYPE_WIRED_HEADSET) return 5;
        return 9;
    }

    /* ---------------- device, apps, keyboard ---------------- */
    @JavascriptInterface public String deviceName() {
        try { String n = Settings.Global.getString(activity.getContentResolver(), "device_name"); if (n != null && !n.isEmpty()) return n; } catch (Exception ignored) { }
        return "Fire TV (" + Build.MODEL + ")";
    }

    @JavascriptInterface public String appVersion() { return BuildConfig.VERSION_NAME; }

    @JavascriptInterface public boolean launchApp(String pkg) {
        PackageManager pm = activity.getPackageManager();
        Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
        if (i == null) i = pm.getLaunchIntentForPackage(pkg);
        if (i == null) return false;
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(i);
        return true;
    }

    /** Hand the stream to another video app (VLC for Fire TV …); Android asks which. */
    @JavascriptInterface public boolean openExternal(String url, String title, String ua) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(url), "video/*");
            if (title != null) { i.putExtra("title", title); i.putExtra(Intent.EXTRA_TITLE, title); }
            if (ua != null) i.putExtra("http-user-agent", ua);
            Intent chooser = Intent.createChooser(i, "Play with");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (i.resolveActivity(activity.getPackageManager()) == null) return false;
            activity.startActivity(chooser);
            return true;
        } catch (Exception e) { return false; }
    }

    @JavascriptInterface public void showKeyboard() {
        activity.runOnUiThread(() -> {
            web.requestFocus();
            InputMethodManager imm = (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
            // an explicit request (Fire OS ignores SHOW_IMPLICIT from a remote); force it if it still didn't open
            imm.showSoftInput(web, 0);
            web.postDelayed(() -> {
                imm.showSoftInput(web, InputMethodManager.SHOW_FORCED);   // never hides an open keyboard
            }, 250);
        });
    }

    /* Typing into a form field: the Fire TV keyboard doesn't reliably type into a WebView's text
       box, so OK on a field opens a real Android text box with the keyboard; Done / OK copies the
       text back (window.__tvText(text), or __tvText(null) when cancelled).
       json: { value, type: text|password|url|number|search|email, label, placeholder, multiline } */
    @JavascriptInterface public void editText(String json) {
        activity.runOnUiThread(() -> {
            JSONObject o;
            try { o = new JSONObject(json); } catch (Exception e) { o = new JSONObject(); }
            final EditText box = new EditText(activity);
            String type = o.optString("type", "text");
            boolean multi = o.optBoolean("multiline", false);
            int it;
            switch (type) {
                case "password": it = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD; break;
                case "url": it = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI; break;
                case "email": it = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS; break;
                case "number": it = InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_SIGNED | InputType.TYPE_NUMBER_FLAG_DECIMAL; break;
                default: it = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
            }
            if (multi) it |= InputType.TYPE_TEXT_FLAG_MULTI_LINE;
            box.setInputType(it);
            box.setSingleLine(!multi);
            box.setText(o.optString("value", ""));
            box.setSelection(box.getText().length());
            box.setHint(o.optString("placeholder", ""));
            box.setImeOptions((type.equals("search") ? EditorInfo.IME_ACTION_SEARCH : EditorInfo.IME_ACTION_DONE) | EditorInfo.IME_FLAG_NO_FULLSCREEN);
            box.setTextSize(20);

            final boolean[] answered = { false };
            final AlertDialog dlg = new AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                    .setTitle(o.optString("label", "Type here"))
                    .setView(box)
                    .setPositiveButton("OK", (d, w) -> { answered[0] = true; textBack(box.getText().toString()); })
                    .setNegativeButton("Cancel", null)
                    .create();
            dlg.setOnDismissListener(d -> { if (!answered[0]) textBack(null); });
            box.setOnEditorActionListener((v, action, ev) -> {
                boolean enter = ev != null && ev.getKeyCode() == KeyEvent.KEYCODE_ENTER && ev.getAction() == KeyEvent.ACTION_DOWN;
                if (action == EditorInfo.IME_ACTION_DONE || action == EditorInfo.IME_ACTION_SEARCH || action == EditorInfo.IME_ACTION_GO || enter) {
                    answered[0] = true;
                    textBack(box.getText().toString());
                    dlg.dismiss();
                    return true;
                }
                return false;
            });
            if (dlg.getWindow() != null) dlg.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
            dlg.show();
            box.requestFocus();
            box.postDelayed(() -> {
                InputMethodManager imm = (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
                imm.showSoftInput(box, InputMethodManager.SHOW_IMPLICIT);
            }, 150);
        });
    }

    private void textBack(String text) {
        final String js = "window.__tvText && window.__tvText(" + (text == null ? "null" : JSONObject.quote(text)) + ")";
        web.post(() -> { web.requestFocus(); web.evaluateJavascript(js, null); });
    }

    /* ---------------- updates (UpdateManager) ---------------- */
    private synchronized UpdateManager updates() { if (updates == null) updates = new UpdateManager(activity); return updates; }

    private interface Job { JSONObject run() throws Exception; }
    private void async(final String id, final Job job) {
        pool.execute(() -> {
            String answer;
            try { answer = new JSONObject().put("ok", true).put("data", job.run()).toString(); }
            catch (Exception e) { answer = "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}"; }
            answers.put(id, answer);
            web.post(() -> web.evaluateJavascript("window.__nativeDone && window.__nativeDone(" + JSONObject.quote(id) + ")", null));
        });
    }

    @JavascriptInterface public void updateCheck(String id) { async(id, () -> updates().check(MainActivity.webVersion)); }

    @JavascriptInterface public void updateInstall(String id) {
        async(id, () -> updates().install(MainActivity.webVersion, (got, total) -> {
            try { emit("updateProgress", new JSONObject().put("got", got).put("total", total).toString()); } catch (Exception ignored) { }
        }));
    }

    /** the new pages are in place: start again from them */
    @JavascriptInterface public void updateRestart() { activity.runOnUiThread(activity::recreate); }

    /** the pages started properly (a downloaded version isn't set aside) */
    @JavascriptInterface public void webReady() { UpdateManager.webReady(activity, MainActivity.webVersion); }

    @JavascriptInterface public String webVersion() { return MainActivity.webVersion; }

    /** the activity is going (MainActivity.onDestroy) */
    void close() { pool.shutdownNow(); }

    @JavascriptInterface public void exitApp() { activity.runOnUiThread(activity::finish); }

    /* ---------------- VPN guard for posters / logos ---------------- */
    @JavascriptInterface public void setGuard(boolean isBlocked, String ua) {
        blocked = isBlocked;
        if (ua != null && !ua.equals(guardUa)) {
            guardUa = ua;
            activity.runOnUiThread(() -> web.getSettings().setUserAgentString(ua));
        }
    }

    /* ---------------- player ---------------- */
    @JavascriptInterface public void play(String json) {
        activity.runOnUiThread(() -> {
            if (PlayerActivity.instance != null) { PlayerActivity.instance.load(json); return; }
            Intent i = new Intent(activity, PlayerActivity.class);
            i.putExtra("json", json);
            activity.startActivity(i);
        });
    }

    @JavascriptInterface public void playerCommand(String json) {
        activity.runOnUiThread(() -> { if (PlayerActivity.instance != null) PlayerActivity.instance.command(json); });
    }
}
