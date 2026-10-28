/* =====================================================================
 * Seal IPTV for Fire TV — ImageCache.java
 * ---------------------------------------------------------------------
 * Every poster / logo the page shows, kept in the app's storage
 * (files/images) the first time: after that it comes from there, through
 * restarts and updates, whatever the provider says about caching (the
 * WebView's own cache is small and often told not to keep them).
 * The Windows app does the same (seal-iptv/src/main/imagecache.js).
 *
 * MainActivity asks here for image requests (GET, Accept: image/…) while
 * the VPN guard allows the network. Anything that isn't a picture, or
 * a picture too big to keep: null — the WebView then loads it itself.
 * At most MAX_BYTES; the ones not shown for longest go first.
 * Addresses that failed are remembered (failed.txt: until when) and answered
 * "not found" at once, so the page shows initials and looks the title up
 * instead of waiting again: a missing file (404 …) for RETRY_AFTER, one that
 * didn't answer in time, dropped the connection or had a server error only
 * for RETRY_SOON (often it was just busy, or the TV was short of memory).
 * ===================================================================== */
package com.sealiptv.tv;

import android.content.Context;
import android.util.Log;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

final class ImageCache {
    private static final long MAX_BYTES = 300L * 1024 * 1024;
    private static final int MAX_ONE = 8 * 1024 * 1024;
    private static final long DAY = 86400000L;
    private static final long RETRY_AFTER = 6 * 3600000L;
    private static final long RETRY_SOON = 10 * 60000L;
    private static final int MAX_FAILED = 20000;

    private final File dir;
    private final Map<String, Object> locks = new HashMap<>();
    private long size = -1;   // bytes on disk (counted on first save)
    private boolean trimming = false;
    private final File failedFile;
    private final java.util.LinkedHashMap<String, Long> failed = new java.util.LinkedHashMap<>();   // url -> tried again after (oldest first)
    private boolean saving = false;

    ImageCache(Context ctx) {
        dir = new File(ctx.getFilesDir(), "images");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        failedFile = new File(dir, "failed.txt");
        try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(new FileInputStream(failedFile), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                int tab = line.indexOf('\t');
                if (tab > 0) failed.put(line.substring(tab + 1), Long.parseLong(line.substring(0, tab)));
            }
        } catch (Exception ignored) { /* none yet */ }
    }

    private boolean recentlyFailed(String url) {
        synchronized (failed) { Long until = failed.get(url); return until != null && System.currentTimeMillis() < until; }
    }

    /** remembers a failed address (saved a few seconds later) and answers "not found" */
    private WebResourceResponse fail(String url) { return fail(url, RETRY_AFTER); }

    private WebResourceResponse fail(String url, long retryIn) {
        synchronized (failed) {
            failed.remove(url);
            failed.put(url, System.currentTimeMillis() + retryIn);
            while (failed.size() > MAX_FAILED) failed.remove(failed.keySet().iterator().next());
            if (!saving) { saving = true; new Thread(this::saveFailed, "image-failed").start(); }
        }
        return notFound();
    }

    private void saveFailed() {
        try { Thread.sleep(3000); } catch (InterruptedException ignored) { }
        StringBuilder out = new StringBuilder();
        synchronized (failed) {
            saving = false;
            for (Map.Entry<String, Long> e : failed.entrySet()) out.append(e.getValue()).append('\t').append(e.getKey()).append('\n');
        }
        File tmp = new File(dir, "failed.txt.tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(out.toString().getBytes(StandardCharsets.UTF_8)); } catch (Exception e) { return; }
        //noinspection ResultOfMethodCallIgnored
        tmp.renameTo(failedFile);
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    /** the picture for url if it's kept (shown also while the VPN guard blocks the network), else null */
    WebResourceResponse kept(String url) { return fromDisk(new File(dir, sha1(url))); }

    /** the picture for url, from storage or fetched and kept; null = let the WebView load it */
    WebResourceResponse get(String url, String ua) {
        File f = new File(dir, sha1(url));
        Object lock;
        synchronized (locks) { lock = locks.get(f.getName()); if (lock == null) { lock = new Object(); locks.put(f.getName(), lock); } }
        try {
            synchronized (lock) {   // the same picture asked for twice at once: fetched once
                WebResourceResponse kept = fromDisk(f);
                if (kept != null) return kept;
                if (recentlyFailed(url)) return notFound();
                return download(url, ua, f);
            }
        } finally {
            synchronized (locks) { locks.remove(f.getName()); }
        }
    }

    private WebResourceResponse fromDisk(File f) {
        if (!f.isFile()) return null;
        try {
            byte[] head = new byte[64];
            int n;
            try (InputStream in = new FileInputStream(f)) { n = in.read(head); }
            String type = sniff(head, Math.max(n, 0));
            if (type == null) { //noinspection ResultOfMethodCallIgnored
                f.delete(); return null; }
            if (System.currentTimeMillis() - f.lastModified() > DAY) //noinspection ResultOfMethodCallIgnored
                f.setLastModified(System.currentTimeMillis());
            return answer(type, new FileInputStream(f));
        } catch (Exception e) { return null; }
    }

    private WebResourceResponse download(String url, String ua, File f) {
        try {
            HttpURLConnection c = null;
            String at = url;
            for (int hop = 0; hop < 5; hop++) {   // redirects, also http <-> https (HttpURLConnection won't)
                c = (HttpURLConnection) new URL(at).openConnection();
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(8000);
                c.setReadTimeout(10000);
                if (ua != null) c.setRequestProperty("User-Agent", ua);
                c.setRequestProperty("Accept", "image/*");
                int code = c.getResponseCode();
                if (code < 300 || code >= 400) break;
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) return fail(url);
                at = new URL(new URL(at), loc).toString();
                if (!at.startsWith("http://") && !at.startsWith("https://")) return fail(url);
                c = null;
            }
            if (c == null || c.getResponseCode() != 200) {
                int code = c == null ? 0 : c.getResponseCode();
                if (c != null) c.disconnect();
                return fail(url, code >= 500 || code == 429 ? RETRY_SOON : RETRY_AFTER);   // busy / broken server: soon
            }
            byte[] body;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream(64 * 1024);
                byte[] b = new byte[32768];
                int n;
                while ((n = in.read(b)) > 0) {
                    buf.write(b, 0, n);
                    if (buf.size() > MAX_ONE) return null;   // too big to keep: the WebView loads it
                }
                body = buf.toByteArray();
            } finally { c.disconnect(); }
            String type = sniff(body, body.length);
            if (type == null) return fail(url);   // not a picture (an error page …)
            File tmp = new File(dir, f.getName() + ".tmp");
            try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(body); }
            if (!tmp.renameTo(f)) { //noinspection ResultOfMethodCallIgnored
                tmp.delete(); }
            added(body.length);
            Log.i("SealImages", "fetched and kept " + body.length + " bytes");   // only new ones: kept ones aren't logged
            synchronized (failed) { failed.remove(url); }   // works again
            return answer(type, new ByteArrayInputStream(body));
        } catch (Exception e) { return fail(url, RETRY_SOON); }   // no answer in time, connection dropped …
    }

    private static WebResourceResponse answer(String type, InputStream in) {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Cache-Control", "max-age=86400");
        return new WebResourceResponse(type, null, 200, "OK", h, in);
    }

    /* ---- the limit ---- */
    private synchronized void added(long n) {
        if (size < 0) { size = 0; File[] all = pictures(); for (File x : all) size += x.length(); }
        else size += n;
        if (size > MAX_BYTES && !trimming) {
            trimming = true;
            new Thread(this::trim, "image-trim").start();
        }
    }

    /** the ones not shown for longest go, down to 90 % */
    private void trim() {
        try {
            File[] all = pictures();
            long[] t = new long[all.length];
            for (int i = 0; i < all.length; i++) t[i] = all[i].lastModified();
            Integer[] order = new Integer[all.length];
            for (int i = 0; i < order.length; i++) order[i] = i;
            Arrays.sort(order, (a, b) -> Long.compare(t[a], t[b]));
            long total = 0;
            for (File x : all) total += x.length();
            for (Integer i : order) {
                if (total <= MAX_BYTES * 9 / 10) break;
                long len = all[i].length();
                if (all[i].delete()) total -= len;
            }
            synchronized (this) { size = total; }
        } finally {
            synchronized (this) { trimming = false; }
        }
    }

    private File[] pictures() {
        File[] all = dir.listFiles((d, name) -> name.matches("[0-9a-f]{40}"));
        return all == null ? new File[0] : all;
    }

    /* ---- helpers ---- */
    /** the picture's type from its first bytes, or null when it isn't one */
    static String sniff(byte[] b, int n) {
        if (n < 4) return null;
        int b0 = b[0] & 0xff, b1 = b[1] & 0xff, b2 = b[2] & 0xff, b3 = b[3] & 0xff;
        if (b0 == 0xff && b1 == 0xd8 && b2 == 0xff) return "image/jpeg";
        if (b0 == 0x89 && b1 == 0x50 && b2 == 0x4e && b3 == 0x47) return "image/png";
        if (b0 == 0x47 && b1 == 0x49 && b2 == 0x46) return "image/gif";
        if (n >= 12 && str(b, 0, 4).equals("RIFF") && str(b, 8, 12).equals("WEBP")) return "image/webp";
        if (n >= 12 && str(b, 4, 8).equals("ftyp") && (str(b, 8, 12).equals("avif") || str(b, 8, 12).equals("avis"))) return "image/avif";
        if (b0 == 0x42 && b1 == 0x4d) return "image/bmp";
        if (b0 == 0 && b1 == 0 && b2 == 1 && b3 == 0) return "image/x-icon";
        String head = new String(b, 0, Math.min(n, 512), StandardCharsets.UTF_8).replace("﻿", "").trim().toLowerCase();
        if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.contains("<svg"))) return "image/svg+xml";
        return null;
    }

    private static String str(byte[] b, int from, int to) { return new String(b, from, to - from, StandardCharsets.ISO_8859_1); }

    private static String sha1(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (byte x : d) out.append(String.format("%02x", x));
            return out.toString();
        } catch (Exception e) { return Integer.toHexString(s.hashCode()); }
    }
}
