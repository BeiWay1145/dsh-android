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
    /**
     * The listening socket. VOLATILE because two threads touch it: the accept
     * loop publishes it after bind and clears it on teardown, while a rebind
     * arrives on the service thread and closes it from under the loop.
     *
     * Measured failure without this: on HarmonyOS every accessibility rebind
     * calls stop() then start(), and the new instance hit
     * 'bind dsh_bridge failed: Address already in use' on EVERY attempt -- the
     * old socket had not been released, because the close() raced the loop's
     * own write of the same field and could miss.
     */
    private volatile LocalServerSocket serverSocket;
    /**
     * Serializes one request at a time.
     *
     * The accept loop hands a connection to a worker instead of serving it
     * inline, so a client that holds a connection open can no longer stop the
     * loop from accepting the next one. Measurements that motivated this: a
     * client that timed out and destroyed its socket left the device-side
     * readLine() blocked, the accept loop parked inside that connection, and
     * every later request HUNG -- connecting fine, never answered. The plugin
     * then had to wait out a full timeout on every call.
     */
    private final java.util.concurrent.Semaphore acceptGate = new java.util.concurrent.Semaphore(1);
    /**
     * Connections currently being served, so stop() can close them.
     *
     * `readLine()` blocks until data arrives or the peer closes; setting a flag
     * cannot wake it. Closing the socket does. Without this, stop() returned
     * while a worker was still parked mid-read holding the name, and the next
     * bind failed with 'Address already in use'.
     */
    private final java.util.Set<LocalSocket> live =
            java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());
    /**
     * Serializes teardown-and-rebind ACROSS SocketServer instances.
     *
     * `onUnbind` and `onServiceConnected` arrive on DIFFERENT threads on
     * HarmonyOS and are not ordered: measured, `connected` fired 3 ms after the
     * previous instance's bind had already failed, while its `unbound` was still
     * 800 ms in the FUTURE. So a new instance could bind while the old one still
     * held the name.
     *
     * A per-instance lock cannot fix that -- the two instances are different
     * objects. This one is static, so a rebind waits for the previous teardown
     * to finish before it tries the name.
     */
    private static final Object REBIND_LOCK = new Object();
    /**
     * The LISTEN socket of the instance that currently owns the name.
     *
     * STATIC on purpose. Measured on HarmonyOS: removing the service from
     * `enabled_accessibility_services` does NOT call onUnbind, so the previous
     * instance keeps its listener and its accept loop — `/proc/net/unix` shows
     * LISTEN=1 with an unchanged PID throughout. The next instance therefore
     * always lost the race for the name, and every rebind logged
     * 'Address already in use' before eventually winning by luck.
     *
     * A new instance can reach the old one only through a static, so it does:
     * before binding, it closes whatever listener is recorded here. That turns
     * a race into a handover.
     */
    private static volatile SocketServer owner;

    SocketServer(BridgeService service) {
        this.service = service;
    }

    void start() {
        acceptThread = new Thread(this::acceptLoop, "dsh-bridge-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    /**
     * Bind while holding the cross-instance lock, so a concurrent teardown cannot
     * be mid-close when the name is taken.
     *
     * Returns true when the socket was bound (or another instance won the race and
     * this one should give up).
     */
    boolean bindLocked() {
        synchronized (REBIND_LOCK) {
            if (!running) return false;
            try {
                LocalServerSocket s = new LocalServerSocket(SOCKET_NAME);
                serverSocket = s;
                owner = this;
                Log.i(TAG, "listening on localabstract:" + SOCKET_NAME);
                return true;
            } catch (Throwable first) {
                // The name is taken. On this platform that is usually OUR OWN
                // previous instance, still alive because the system never told it
                // to stop. Take the name back from it rather than waiting for a
                // teardown that is not coming.
                SocketServer previous = owner;
                if (previous != null && previous != this) {
                    previous.releaseForHandover();
                    try {
                        LocalServerSocket s = new LocalServerSocket(SOCKET_NAME);
                        serverSocket = s;
                        owner = this;
                        Log.i(TAG, "listening on localabstract:" + SOCKET_NAME + " (handover)");
                        return true;
                    } catch (Throwable ignored) {
                        // Fall through: the caller backs off and retries.
                    }
                }
                // Nobody owns the name, yet the bind still failed: the previous
                // listener is a DYING socket whose close() has returned but whose
                // abstract name the kernel has not released yet. Measured on
                // HarmonyOS: unbound at 45.375, connected at 46.112, first bind
                // failing at 46.114 and succeeding at 46.366 -- a fixed 252 ms,
                // which is exactly the accept loop backoff. The release is
                // asynchronous, so a short bounded re-probe beats paying that
                // backoff in full.
                for (int i = 0; i < 6; i++) {
                    sleepQuietly(40L);
                    if (!running) return false;
                    try {
                        LocalServerSocket s = new LocalServerSocket(SOCKET_NAME);
                        serverSocket = s;
                        owner = this;
                        Log.i(TAG, "listening on localabstract:" + SOCKET_NAME
                                + " (released after " + (i + 1) * 40 + "ms)");
                        return true;
                    } catch (Throwable ignored) {
                        // Still held; keep probing.
                    }
                }
                return false;
            }
        }
    }

    /**
     * Give up the listener to a replacement instance.
     *
     * Stops the loop and closes the socket, but leaves the object usable if the
     * handover fails and its own loop decides to retry.
     */
    private void releaseForHandover() {
        LocalServerSocket s = serverSocket;
        serverSocket = null;
        if (s != null) {
            try {
                s.close();
            } catch (Throwable ignored) {
            }
        }
    }

    /**
     * Stop the loop and RELEASE the abstract name before returning.
     *
     * Releasing matters more than stopping. A rebind calls stop() and then
     * start() immediately; if the name is still held at that moment, the new
     * bind fails with 'Address already in use' and the connection is accepted
     * by nobody -- a HANG rather than an error. Measured on HarmonyOS: 4.0 s
     * lost on one rebind, 11.0 s across five.
     *
     * The close is done through a LOCAL reference after clearing the field, so
     * the accept loop's own cleanup cannot race this one into closing nothing.
     */
    void stop() {
        running = false;
        // Give up ownership BEFORE closing, so a replacement instance that finds
        // the name still held does not waste its handover attempt on an object
        // that is already torn down -- and, more importantly, so it can tell
        // "no owner: the name is held by a dying socket" from "owner alive: the
        // name is genuinely still in use".
        if (owner == this) owner = null;
        LocalServerSocket s = serverSocket;
        serverSocket = null;
        if (s != null) {
            try {
                s.close();
            } catch (Throwable ignored) {
            }
        }
        // Wake any worker parked in readLine(). Closing its socket makes the read
        // return, so the worker reaches its finally and releases the name.
        for (LocalSocket open : live) {
            try {
                open.close();
            } catch (Throwable ignored) {
            }
        }
        live.clear();
        // Wait for the loop to leave accept(), so the caller knows the name is
        // free before it binds again. Bounded: a stuck accept() must not hang
        // the service thread, and the loop closes the socket itself when it
        // wakes.
        Thread t = acceptThread;
        acceptThread = null;
        if (t != null && t != Thread.currentThread()) {
            try {
                t.join(500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
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
            LocalServerSocket listening;
            try {
                // Bound under the cross-instance lock: a concurrent teardown from a
                // previous instance must not be mid-close while we take the name.
                if (!bindLocked()) {
                    throw new java.io.IOException("Address already in use (or stopped)");
                }
                listening = serverSocket;
                attempt = 0;
            } catch (Throwable t) {
                attempt++;
                Log.e(TAG, "bind " + SOCKET_NAME + " failed (attempt " + attempt + "): " + t);
                // 'Address already in use' is a SHORT race with the previous
                // instance's teardown, not a lasting condition. The old backoff
                // started at 2 s and grew, which turned a sub-second race into
                // seconds of downtime: measured 11.0 s of unavailability across
                // five rebinds. Retry quickly at first, and only back off if the
                // name really is held by something else.
                sleepQuietly(Math.min(250L * attempt, 2000L));
                continue;
            }
            try {
                while (running) {
                    LocalSocket client = listening.accept();
                    // Serve on a WORKER, never inline. A client that connects and
                    // then stalls (or times out and destroys its socket) leaves
                    // readLine() blocked; serving inline parked this loop inside
                    // that connection so every later request hung unanswered.
                    // The gate keeps one request in flight at a time, which is
                    // what the accessibility reads want.
                    Thread worker = new Thread(() -> {
                        try {
                            acceptGate.acquire();
                            try {
                                serve(client);
                            } finally {
                                acceptGate.release();
                            }
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }, "dsh-bridge-serve");
                    worker.setDaemon(true);
                    worker.start();
                }
            } catch (Throwable t) {
                if (!running) break;
                Log.w(TAG, "accept loop interrupted, rebinding: " + t);
            } finally {
                // Close through the LOCAL reference and clear the field only if it
                // is still ours -- two writers of this field was the race that let
                // a close() land on nothing and leak the abstract name.
                try {
                    listening.close();
                } catch (Throwable ignored) {
                }
                if (serverSocket == listening) serverSocket = null;
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

    /**
     * Serve one connection until the peer disconnects, then ALWAYS close it.
     *
     * Closing is not tidiness -- it is what frees the abstract name. Measured on
     * a HarmonyOS device: without this, clients that timed out and went away left
     * their LocalSocket open, and /proc/net/unix accumulated them (1 LISTEN plus
     * 21 established-but-dead after a few rebinds). The next `new
     * LocalServerSocket(SOCKET_NAME)` then failed with 'Address already in use'
     * even though our own stop() had closed the listener, because the name was
     * still held by those orphaned connections.
     */
    private void serve(LocalSocket client) {
        live.add(client);
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
            // A client that vanished mid-read is the normal end of a short-lived
            // connection, not an error worth a stack trace.
            Log.d(TAG, "connection ended: " + t);
        } finally {
            live.remove(client);
            // THE IMPORTANT LINE. See the method comment.
            try {
                client.close();
            } catch (Throwable ignored) {
            }
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
                    return "{\"id\":" + id + ",\"ok\":true,\"revision\":" + service.revision()
                        + ",\"xml\":" + jsonString(xml) + "}";
                }
                case "revision":
                    return "{\"id\":" + id + ",\"ok\":true,\"revision\":" + service.revision() + "}";
                case "dump_if_changed": {
                    // The caller passes the revision of the tree it already holds.
                    // An unchanged counter means the tree it has is still valid,
                    // so the reply carries no XML at all — that is the whole saving.
                    long known = readLong(line, "known", -1L);
                    long now = service.revision();
                    if (known >= 0 && known == now) {
                        return "{\"id\":" + id + ",\"ok\":true,\"revision\":" + now + ",\"unchanged\":true}";
                    }
                    android.view.accessibility.AccessibilityNodeInfo root = service.currentRoot();
                    if (root == null) return error(id, "no active window (screen may be off or locked)");
                    int[] frame = service.appFrame();
                    String xml = TreeDumper.dump(root, service.rotation(), frame[0], frame[1]);
                    return "{\"id\":" + id + ",\"ok\":true,\"revision\":" + now
                        + ",\"unchanged\":false,\"xml\":" + jsonString(xml) + "}";
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

    private static long readLong(String json, String key, long fallback) {
        String v = readRaw(json, key);
        if (v == null) return fallback;
        try {
            return Long.parseLong(v.trim());
        } catch (NumberFormatException e) {
            return fallback;
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

}