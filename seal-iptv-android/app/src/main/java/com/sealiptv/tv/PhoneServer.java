/* =====================================================================
 * Seal IPTV for Fire TV — PhoneServer.java   ("Set up from your phone")
 * ---------------------------------------------------------------------
 * While the TV shows the QR code, a small web server on the home network:
 *   GET  /       the phone's page (its HTML comes from the web part:
 *                start(port, html, hello), so an updated web part updates it too)
 *   GET  /hello  { app: "seal-iptv-setup", name } — how another Seal IPTV on the
 *                network (a PC, a TV: "Connect a TV") finds this one
 *   POST /send   what the phone filled in — encrypted on the phone with a
 *                key from the code in the QR (it never travels over the
 *                network): passed to the page as the event "phonePost"
 *                { id, body }, and the page's answer (reply(id, json),
 *                "Connected" / "Wrong passphrase") goes back to the phone
 * Nothing else is answered. It stops when the TV's window closes (stop()),
 * after 15 minutes, or after 20 posts that weren't for this code.
 * ===================================================================== */
package com.sealiptv.tv;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import org.json.JSONObject;

class PhoneServer {
    private static final long LIFETIME = 15 * 60 * 1000;
    private static final int MAX_BODY = 64 * 1024;

    private final NativeBridge bridge;
    private ServerSocket socket;
    private volatile String html = "";
    private volatile String hello = "{}";
    private volatile long until = 0;
    private int nextId = 1;
    private final Map<String, String[]> replies = new ConcurrentHashMap<>();
    private final Map<String, CountDownLatch> waits = new ConcurrentHashMap<>();

    PhoneServer(NativeBridge bridge) { this.bridge = bridge; }

    /** Listens on port (or the next free one of the ten after it). -> the port, or -1 */
    synchronized int start(int port, String page, String helloJson) {
        stop();
        html = page == null ? "" : page;
        hello = helloJson == null ? "{}" : helloJson;
        for (int p = port; p < port + 10; p++) {
            try {
                ServerSocket s = new ServerSocket();
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress(p));
                socket = s;
                until = System.currentTimeMillis() + LIFETIME;
                Thread t = new Thread(() -> accept(s), "seal-phone-setup");
                t.setDaemon(true);
                t.start();
                return p;
            } catch (Exception ignored) { /* taken: the next one */ }
        }
        return -1;
    }

    synchronized void stop() {
        if (socket != null) { try { socket.close(); } catch (Exception ignored) { } socket = null; }
        for (CountDownLatch l : waits.values()) l.countDown();
    }

    /** The page's answer to a post: back to the phone. */
    void reply(String id, String json) {
        CountDownLatch l = waits.get(id);
        if (l == null) return;
        replies.put(id, new String[] { json });
        l.countDown();
    }

    private void accept(ServerSocket s) {
        while (!s.isClosed()) {
            try {
                final Socket c = s.accept();
                if (System.currentTimeMillis() > until) { c.close(); stop(); return; }
                Thread t = new Thread(() -> handle(c), "seal-phone-setup-req");
                t.setDaemon(true);
                t.start();
            } catch (Exception e) { return; }
        }
    }

    private void handle(Socket c) {
        try (Socket sock = c) {
            sock.setSoTimeout(15000);
            InputStream in = sock.getInputStream();
            String head = readHead(in);
            if (head == null) return;
            String[] first = head.split("\r\n", 2)[0].split(" ");
            if (first.length < 2) return;
            String method = first[0], path = first[1];
            OutputStream out = sock.getOutputStream();
            if ("GET".equals(method) && (path.equals("/") || path.startsWith("/?"))) {
                send(out, 200, "text/html; charset=utf-8", html);
            } else if ("GET".equals(method) && path.equals("/hello")) {
                send(out, 200, "application/json", hello);
            } else if ("POST".equals(method) && path.equals("/send")) {
                int len = 0;
                for (String line : head.split("\r\n")) if (line.toLowerCase().startsWith("content-length:")) len = Integer.parseInt(line.substring(15).trim());
                if (len <= 0 || len > MAX_BODY) { send(out, 413, "application/json", "{\"ok\":false,\"error\":\"too big\"}"); return; }
                byte[] body = new byte[len];
                int got = 0;
                while (got < len) { int n = in.read(body, got, len - got); if (n < 0) break; got += n; }
                String id;
                synchronized (this) { id = "p" + (nextId++); }
                CountDownLatch l = new CountDownLatch(1);
                waits.put(id, l);
                JSONObject ev = new JSONObject();
                ev.put("id", id);
                ev.put("body", new String(body, 0, got, StandardCharsets.UTF_8));
                bridge.emit("phonePost", ev.toString());
                // connecting to a sync server can take a while: up to a minute for the TV's answer
                boolean answered = l.await(60, TimeUnit.SECONDS);
                waits.remove(id);
                String[] r = replies.remove(id);
                send(out, 200, "application/json", answered && r != null ? r[0] : "{\"ok\":false,\"error\":\"The TV didn't answer. Is the window with the QR code still open?\"}");
            } else {
                send(out, 404, "text/plain", "Not here");
            }
        } catch (Exception ignored) { }
    }

    private static String readHead(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int last4 = 0, ch;
        while ((ch = in.read()) >= 0) {
            b.write(ch);
            last4 = (last4 << 8) | ch;
            if (last4 == 0x0d0a0d0a) return b.toString("UTF-8");
            if (b.size() > 16 * 1024) return null;
        }
        return null;
    }

    private static void send(OutputStream out, int status, String type, String text) throws Exception {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + (status == 200 ? " OK" : status == 404 ? " Not Found" : " Error") + "\r\n"
            + "Content-Type: " + type + "\r\nContent-Length: " + body.length + "\r\nCache-Control: no-store\r\n"
            + "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }
}
