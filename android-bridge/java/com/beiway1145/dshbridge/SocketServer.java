package com.beiway1145.dshbridge;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.util.Log;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A local (abstract-namespace) socket that answers line-delimited JSON
 * requests. One client at a time is enough: the DSH plugin drives one device
 * from one process, and serializing requests keeps the accessibility reads on
 * a single thread, which is what the platform expects.
 *
 * Protocol — one request per line, one response per line:
 *   {"id":1,"cmd":"ping"}
 *     -> {"id":1,"ok":true,"pong":true,"version":"1"}
 *   {"id":2,"cmd":"dump"}
 *     -> {"id":2,"ok":true,"xml":"<hierarchy ...>...</hierarchy>"}
 *     -> {"id":2,"ok":false,"error":"..."}
 *
 * The response carries uiautomator's XML verbatim rather than a bespoke JSON
 * tree, so the plugin reuses its existing parser unchanged.
 */
final class SocketServer {

    private static final String TAG = "dsh-bridge";

    /**
     * Abstract namespace name. Reachable from the host with
     * `adb forward tcp:<port> localabstract:dsh_bridge`, which needs no
     * device-side path and cannot collide with a file on disk.
     */
    static final String SOCKET_NAME = "dsh_bridge";

    private static final String VERSION = "1";

    private final BridgeService service;
    private final AtomicInteger seq = new AtomicInteger();
    private volatile boolean running = true;
    private Thread acceptThread;
    private LocalServerSocket serverSocket;

    SocketServer(BridgeService service) {
        this.service = service;
    }

    void start() {
        acceptThread = new Thread(this::acceptLoop, "dsh-bridge-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (Throwable ignored) {
        }
        serverSocket = null;
    }

    private void acceptLoop() {
        // Self-healing: a transient bind failure (or a socket torn down by a
        // service unbind) must NOT kill this thread permanently. An earlier
        // version logged and `return`ed here, which left the process alive with
        // no listening socket at all — the client then hung until timeout with
        // nothing in the logs to explain it (measured: happened on every
        // accessibility-service toggle).
        int attempt = 0;
        while (running) {
            try {
                serverSocket = new LocalServerSocket(SOCKET_NAME);
                attempt = 0;
                Log.i(TAG, "listening on localabstract:" + SOCKET_NAME);
            } catch (Throwable t) {
                attempt++;
                Log.e(TAG, "bind " + SOCKET_NAME + " failed (attempt " + attempt + "): " + t);
                sleepQuietly(Math.min(2000L * attempt, 10000L));
                continue;
            }
            try {
                while (running) {
                    LocalSocket client = serverSocket.accept();
                    serve(client);
                }
            } catch (Throwable t) {
                if (!running) break;
                Log.w(TAG, "accept loop interrupted, rebinding: " + t);
            } finally {
                try {
                    if (serverSocket != null) serverSocket.close();
                } catch (Throwable ignored) {
                }
                serverSocket = null;
            }
            if (running) sleepQuietly(250L);
        }
    }

    /** A bind collision right after a rebind is normal; back off and retry. */
    private static void sleepQuietly(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Serve one connection until the peer disconnects. */
    private void serve(LocalSocket client) {
        try {
            BufferedReader in = new BufferedReader(
                    new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            OutputStream out = client.getOutputStream();
            String line;
            while (running && (line = in.readLine()) != null) {
                if (line.isEmpty()) continue;
                String response = handle(line);
                out.write(response.getBytes(StandardCharsets.UTF_8));
                out.write('\n');
                out.flush();
            }
        } catch (Throwable t) {
            Log.w(TAG, "connection ended: " + t);
        }
    }

    /**
     * Dispatch one request line. Never throws: a malformed request becomes an
     * `ok:false` response so a client bug cannot kill the server thread (the
     * service must outlive any single bad call).
     */
    private String handle(String line) {
        int id = -1;
        try {
            id = readInt(line, "id");
            String cmd = readString(line, "cmd");
            if (cmd == null) return error(id, "missing \"cmd\"");
            switch (cmd) {
                case "ping":
                    return "{\"id\":" + id + ",\"ok\":true,\"pong\":true,\"version\":\"" + VERSION + "\"}";
                case "dump": {
                    android.view.accessibility.AccessibilityNodeInfo root = service.currentRoot();
                    if (root == null) return error(id, "no active window (screen may be off or locked)");
                    int[] frame = service.appFrame();
                    String xml = TreeDumper.dump(root, service.rotation(), frame[0], frame[1]);
                    return "{\"id\":" + id + ",\"ok\":true,\"xml\":" + jsonString(xml) + "}";
                }
                default:
                    return error(id, "unknown cmd: " + cmd);
            }
        } catch (Throwable t) {
            return error(id, String.valueOf(t));
        }
    }

    private static String error(int id, String message) {
        return "{\"id\":" + id + ",\"ok\":false,\"error\":" + jsonString(message) + "}";
    }

    // ── minimal JSON reading/writing (no dependency: the APK has no deps) ──

    private static int readInt(String json, String key) {
        String v = readRaw(json, key);
        if (v == null) return -1;
        try {
            return Integer.parseInt(v.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static String readString(String json, String key) {
        String v = readRaw(json, key);
        if (v == null) return null;
        return unquote(v.trim());
    }

    /** The raw token following {@code "key":} up to the next top-level comma/brace. */
    private static String readRaw(String json, String key) {
        String needle = "\"" + key + "\"";
        int k = json.indexOf(needle);
        if (k < 0) return null;
        int colon = json.indexOf(':', k + needle.length());
        if (colon < 0) return null;
        int i = colon + 1;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        int start = i;
        boolean inStr = false;
        while (i < json.length()) {
            char c = json.charAt(i);
            if (inStr) {
                if (c == '\\') { i += 2; continue; }
                if (c == '"') { i++; break; }
            } else {
                if (c == '"') inStr = true;
                else if (c == ',' || c == '}') break;
            }
            i++;
        }
        return json.substring(start, Math.min(i, json.length()));
    }

    private static String unquote(String s) {
        if (s.length() >= 2 && s.charAt(0) == '"' && s.charAt(s.length() - 1) == '"') {
            s = s.substring(1, s.length() - 1);
        }
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                char n = s.charAt(++i);
                switch (n) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case 'r': sb.append('\r'); break;
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case '/': sb.append('/'); break;
                    case 'u':
                        if (i + 4 < s.length()) {
                            try {
                                sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                                i += 4;
                            } catch (NumberFormatException e) {
                                sb.append(n);
                            }
                        } else sb.append(n);
                        break;
                    default: sb.append(n);
                }
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static String jsonString(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 16);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }

    private static void closeQuietly(LocalSocket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (Throwable ignored) {
        }
    }
}