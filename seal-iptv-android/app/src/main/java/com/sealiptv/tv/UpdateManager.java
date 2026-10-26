/* =====================================================================
 * Seal IPTV for Fire TV — UpdateManager.java   (new versions from GitHub)
 * ---------------------------------------------------------------------
 * Same releases as the Windows app (seal-iptv/src/main/updater.js):
 * github.com/jeffbristow/SealIPTV/releases, tag v<version>, with
 *   update.json + update.json.sig   signed with the release key (ECDSA
 *                                   P-256); its public half is below
 *   SealIPTV-TV-<v>.zip             the app's pages and logic (assets/www)
 *   SealIPTV-FireTV-<v>.apk         the whole app
 * update.json "tv": { "web": { file, sha256, size, minNative },
 *                     "apk": { file, sha256, size, versionCode } }
 *
 * Most releases only change the pages and logic: the zip is unpacked to
 * files/web/<version>/ and the app reloads from there — no installer.
 * When the Android part changed (web.minNative is newer than this app),
 * the APK is downloaded and Android's installer asks to install it
 * (it must be signed with the same key as the installed app).
 *
 * A downloaded web version that never finishes starting (twice) is set
 * aside and the app's built-in pages are used again (see pickWeb).
 * ===================================================================== */
package com.sealiptv.tv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

final class UpdateManager {
    static final String REPO = "jeffbristow/SealIPTV";
    // the release key's public half (SPKI, base64) — the same one is in updater.js
    static final String PUBLIC_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKZIU9roCGtSAm7JCS63cE0dsI38vgGnjMGCDoWII7MTZJRRs7kkpfj8/MOqzDNDfyHkS8er9VS/GN9dll4v3KQ==";
    private static final Pattern TAG = Pattern.compile("^v(\\d+\\.\\d+\\.\\d+)$");
    private static final String PREFS = "updates";

    interface Progress { void on(long got, long total); }

    private final Activity activity;
    private JSONObject found;      // { version, tag, kind, part (the web / apk part), notes, page }
    private File readyApk;         // downloaded + checked, waiting for Android's installer
    private String readyVersion;

    UpdateManager(Activity activity) { this.activity = activity; }

    /* ---------------- versions ---------------- */
    static int cmp(String a, String b) {
        String[] pa = String.valueOf(a).split("\\."), pb = String.valueOf(b).split("\\.");
        for (int i = 0; i < Math.max(pa.length, pb.length); i++) {
            int x = i < pa.length ? num(pa[i]) : 0, y = i < pb.length ? num(pb[i]) : 0;
            if (x != y) return x > y ? 1 : -1;
        }
        return 0;
    }
    private static int num(String s) { try { return Integer.parseInt(s.replaceAll("\\D.*$", "")); } catch (Exception e) { return 0; } }

    static String builtInWebVersion(Context c) {
        try (InputStream in = c.getAssets().open("www/version.json")) {
            return new JSONObject(new String(readAll(in, 4096, null, 0), StandardCharsets.UTF_8)).optString("version", "0");
        } catch (Exception e) { return BuildConfig.VERSION_NAME; }
    }

    static File webDir(Context c) { return new File(c.getFilesDir(), "web"); }

    /** The web version MainActivity loads: a downloaded one (newer than the built-in pages) or null = built in. */
    static String pickWeb(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String ver = p.getString("web", null);
        if (ver == null) return null;
        File dir = new File(webDir(c), ver);
        boolean ok = new File(dir, "index.html").isFile() && cmp(ver, builtInWebVersion(c)) > 0 && !p.getBoolean("bad-" + ver, false);
        if (ok) {
            try (InputStream in = new FileInputStream(new File(dir, "version.json"))) {
                JSONObject v = new JSONObject(new String(readAll(in, 4096, null, 0), StandardCharsets.UTF_8));
                ok = ver.equals(v.optString("version")) && v.optInt("minNative", 0) <= BuildConfig.VERSION_CODE;
            } catch (Exception e) { ok = false; }
        }
        int tries = p.getInt("tries-" + ver, 0);
        if (ok && tries >= 2) { p.edit().putBoolean("bad-" + ver, true).apply(); ok = false; }   // started twice without getting going
        if (!ok) return null;
        p.edit().putInt("tries-" + ver, tries + 1).apply();
        return ver;
    }

    /** The pages started properly (core.js says so): this version is fine. */
    static void webReady(Context c, String ver) {
        if (ver != null) c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("tries-" + ver).apply();
    }

    /* ---------------- finding the newest release ---------------- */
    private static String download(String tag, String file) {
        return "https://github.com/" + REPO + "/releases/download/" + tag + "/" + Uri.encode(file);
    }

    static boolean verify(byte[] data, String sigB64) {
        try {
            PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(Base64.decode(PUBLIC_KEY, Base64.DEFAULT)));
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(key);
            s.update(data);
            return s.verify(Base64.decode(sigB64.trim(), Base64.DEFAULT));
        } catch (Exception e) { return false; }
    }

    /** -> { current, latest, available, kind: web | apk | null, ready, notes, page, size } */
    synchronized JSONObject check(String runningWeb) throws Exception {
        JSONArray list;
        try { list = new JSONArray(new String(get("https://api.github.com/repos/" + REPO + "/releases?per_page=20", 5 << 20, null), StandardCharsets.UTF_8)); }
        catch (Exception e) { if (String.valueOf(e.getMessage()).contains("answered 404")) list = new JSONArray(); else throw e; }   // no releases yet
        List<JSONObject> rels = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject r = list.optJSONObject(i);
            if (r == null || r.optBoolean("draft") || r.optBoolean("prerelease") || !TAG.matcher(r.optString("tag_name")).matches()) continue;
            rels.add(r);
        }
        rels.sort((a, b) -> cmp(ver(b.optString("tag_name")), ver(a.optString("tag_name"))));
        JSONObject out = new JSONObject();
        out.put("current", runningWeb);
        out.put("available", false);
        out.put("page", "https://github.com/" + REPO + "/releases");
        found = null;
        for (int i = 0; i < Math.min(3, rels.size()); i++) {
            JSONObject r = rels.get(i);
            String tag = r.optString("tag_name");
            if (!hasAsset(r, "update.json") || !hasAsset(r, "update.json.sig")) continue;
            byte[] json = get(download(tag, "update.json"), 1 << 20, null);
            String sig = new String(get(download(tag, "update.json.sig"), 4096, null), StandardCharsets.UTF_8);
            if (!verify(json, sig)) throw new Exception("The update information for " + tag + " isn't signed by Seal IPTV, so it was ignored.");
            JSONObject m = new JSONObject(new String(json, StandardCharsets.UTF_8));
            String version = m.optString("version");
            if (!version.equals(ver(tag))) throw new Exception("The update information for " + tag + " is for another version, so it was ignored.");
            JSONObject tv = m.optJSONObject("tv");
            JSONObject web = tv == null ? null : tv.optJSONObject("web");
            JSONObject apk = tv == null ? null : tv.optJSONObject("apk");
            String kind = null;
            JSONObject part = null;
            boolean apkNewer = apk != null && apk.optInt("versionCode", 0) > BuildConfig.VERSION_CODE;
            if (cmp(version, runningWeb) > 0) {
                if (web != null && web.optInt("minNative", 0) <= BuildConfig.VERSION_CODE) { kind = "web"; part = web; }
                else if (apkNewer) { kind = "apk"; part = apk; }
            } else if (apkNewer) { kind = "apk"; part = apk; }
            out.put("latest", version);
            out.put("notes", r.optString("body", m.optString("notes", "")));
            if (r.optString("html_url").startsWith("https://github.com/")) out.put("page", r.optString("html_url"));
            if (kind != null) {
                out.put("available", true);
                out.put("kind", kind);
                out.put("size", part.optLong("size", 0));
                out.put("ready", "apk".equals(kind) && readyApk != null && version.equals(readyVersion));
                found = new JSONObject().put("version", version).put("tag", tag).put("kind", kind).put("part", part);
            }
            return out;
        }
        return out;
    }

    private static String ver(String tag) { Matcher m = TAG.matcher(tag); return m.matches() ? m.group(1) : "0"; }
    private static boolean hasAsset(JSONObject r, String name) {
        JSONArray a = r.optJSONArray("assets");
        if (a != null) for (int i = 0; i < a.length(); i++) { JSONObject x = a.optJSONObject(i); if (x != null && name.equals(x.optString("name"))) return true; }
        return false;
    }

    /* ---------------- installing ---------------- */
    /** -> { version, reload } (web: reload the app) | { version, androidInstaller } | { version, permission } */
    synchronized JSONObject install(String runningWeb, Progress progress) throws Exception {
        if (found == null) check(runningWeb);
        if (found == null) throw new Exception("There's no newer version to install.");
        String version = found.getString("version"), tag = found.getString("tag"), kind = found.getString("kind");
        JSONObject part = found.getJSONObject("part");
        String file = part.optString("file"), sha = part.optString("sha256");
        if (file.isEmpty() || !sha.matches("[0-9a-f]{64}")) throw new Exception("This release has nothing to install on a Fire TV.");
        JSONObject out = new JSONObject().put("version", version);

        if ("apk".equals(kind)) {
            if (readyApk == null || !version.equals(readyVersion) || !readyApk.isFile() || !sha.equals(sha256(readyApk))) {
                byte[] data = checked(get(download(tag, file), 300 << 20, progress), part);
                File dir = new File(activity.getCacheDir(), "updates");
                deleteTree(dir);
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
                File apk = new File(dir, "SealIPTV-" + version + ".apk");
                try (OutputStream os = new FileOutputStream(apk)) { os.write(data); }
                readyApk = apk;
                readyVersion = version;
            }
            if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
                // Fire OS asks once: "Allow Seal IPTV to install unknown apps"
                Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()));
                activity.runOnUiThread(() -> { try { activity.startActivity(i); } catch (Exception ignored) { } });
                return out.put("permission", true);
            }
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".updates", readyApk);
            Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.runOnUiThread(() -> activity.startActivity(i));
            return out.put("androidInstaller", true);
        }

        // web: unpack next to the others, then switch
        byte[] data = checked(get(download(tag, file), 100 << 20, progress), part);
        File root = webDir(activity);
        File tmp = new File(root, version + ".tmp");
        File dest = new File(root, version);
        deleteTree(tmp);
        //noinspection ResultOfMethodCallIgnored
        tmp.mkdirs();
        String base = tmp.getCanonicalPath() + File.separator;
        try (ZipInputStream z = new ZipInputStream(new java.io.ByteArrayInputStream(data))) {
            ZipEntry e;
            byte[] b = new byte[65536];
            while ((e = z.getNextEntry()) != null) {
                File f = new File(tmp, e.getName());
                if (!f.getCanonicalPath().startsWith(base)) throw new Exception("The update package is damaged.");
                if (e.isDirectory()) { //noinspection ResultOfMethodCallIgnored
                    f.mkdirs(); continue; }
                //noinspection ResultOfMethodCallIgnored
                f.getParentFile().mkdirs();
                try (OutputStream os = new FileOutputStream(f)) { int n; while ((n = z.read(b)) > 0) os.write(b, 0, n); }
            }
        }
        JSONObject v;
        try (InputStream in = new FileInputStream(new File(tmp, "version.json"))) { v = new JSONObject(new String(readAll(in, 4096, null, 0), StandardCharsets.UTF_8)); }
        if (!new File(tmp, "index.html").isFile() || !version.equals(v.optString("version"))) { deleteTree(tmp); throw new Exception("The update package isn't Seal IPTV " + version + "."); }
        deleteTree(dest);
        if (!tmp.renameTo(dest)) throw new Exception("Couldn't save the update.");
        SharedPreferences p = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        p.edit().putString("web", version).remove("bad-" + version).remove("tries-" + version).apply();
        // keep the running version (a fallback while this one starts), remove the rest
        File[] old = root.listFiles();
        if (old != null) for (File f : old) if (!f.getName().equals(version) && !f.getName().equals(runningWeb)) deleteTree(f);
        return out.put("reload", true);
    }

    private static byte[] checked(byte[] data, JSONObject part) throws Exception {
        long size = part.optLong("size", 0);
        if (size > 0 && data.length != size) throw new Exception("The download is incomplete. Try again.");
        if (!part.optString("sha256").equals(hex(MessageDigest.getInstance("SHA-256").digest(data)))) throw new Exception("The download doesn't match the signed release, so it wasn't installed.");
        return data;
    }

    /* ---------------- downloads ---------------- */
    private static byte[] get(String url, int max, Progress progress) throws Exception {
        if (!url.startsWith("https://github.com/") && !url.startsWith("https://api.github.com/")) throw new Exception("Updates only come from github.com.");
        for (int hop = 0; hop < 6; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(60000);
            c.setRequestProperty("User-Agent", "SealIPTV/" + BuildConfig.VERSION_NAME + " (Fire TV)");
            if (url.startsWith("https://api.github.com/")) c.setRequestProperty("Accept", "application/vnd.github+json");
            int status;
            try { status = c.getResponseCode(); }
            catch (java.io.IOException e) { throw new Exception("Couldn't reach GitHub. Check the internet connection."); }
            String loc = c.getHeaderField("Location");
            if (status >= 300 && status < 400 && loc != null) {
                url = new URL(new URL(url), loc).toString();
                c.disconnect();
                if (!url.startsWith("https://")) throw new Exception("GitHub sent the download somewhere unsafe.");
                continue;
            }
            if (status == 403 || status == 429) throw new Exception("GitHub is busy (too many update checks). Try again in an hour.");
            if (status != 200) throw new Exception("GitHub answered " + status + ".");
            long total = c.getContentLengthLong();
            if (total > max) throw new Exception("The download is too big.");
            try (InputStream in = c.getInputStream()) { return readAll(in, max, progress, total); }
            finally { c.disconnect(); }
        }
        throw new Exception("Too many redirects from GitHub.");
    }

    private static byte[] readAll(InputStream in, int max, Progress progress, long total) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] b = new byte[65536];
        int n;
        long got = 0, lastTick = 0;
        while ((n = in.read(b)) > 0) {
            got += n;
            if (got > max) throw new Exception("The download is too big.");
            buf.write(b, 0, n);
            if (progress != null && got - lastTick > 256 * 1024) { lastTick = got; progress.on(got, total); }
        }
        return buf.toByteArray();
    }

    private static String sha256(File f) throws Exception {
        MessageDigest d = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) { byte[] b = new byte[65536]; int n; while ((n = in.read(b)) > 0) d.update(b, 0, n); }
        return hex(d.digest());
    }

    private static String hex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x)); return s.toString(); }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
