package com.beiway1145.dshbridge;

import android.accessibilityservice.AccessibilityService;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * Holds one long-lived accessibility connection and serves tree dumps over a
 * local socket.
 *
 * The whole point: `uiautomator dump` pays a JVM start (~0.5 s) plus class
 * loading (~1.2 s) on EVERY call because the CLI tool is a fresh process each
 * time. A bound AccessibilityService is started once by the system and then
 * simply stays alive, so a dump costs only the tree walk plus serialization.
 *
 * The service is inert until it is enabled in Settings and something connects
 * to the socket; it never touches the screen on its own.
 */
public class BridgeService extends AccessibilityService {

    private static final String TAG = "dsh-bridge";

    /** The socket server, started once from onServiceConnected. */
    private SocketServer server;

    /** The most recent window the system reported, refreshed by events. */
    private volatile AccessibilityNodeInfo lastRoot;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        Log.i(TAG, "accessibility service connected");
        // Always (re)establish: a reconnect after an unbind must not be left
        // without a listener. start() is idempotent from the caller's side
        // because a fresh SocketServer owns a fresh thread.
        if (server != null) {
            server.stop();
            server = null;
        }
        server = new SocketServer(this);
        server.start();
        // A first root so an immediate client call has something to answer with
        // even before any window event arrives.
        lastRoot = getRootInActiveWindow();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Cheap: keep a handle on the current root. The actual dump re-reads it
        // at call time, so a missed event can never serve a stale tree.
        try {
            lastRoot = getRootInActiveWindow();
        } catch (Throwable ignored) {
            // A window can vanish between the event and this read.
        }
    }

    @Override
    public void onInterrupt() {
        // Nothing to do: no gestures are dispatched from here.
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        Log.i(TAG, "accessibility service unbound");
        if (server != null) {
            server.stop();
            server = null;
        }
        return super.onUnbind(intent);
    }

    /**
     * The current frontmost window's root.
     *
     * Always re-read (never trusts {@link #lastRoot} alone) because the cached
     * handle can belong to a window that has since been dismissed, and a dump
     * from a dead window would be silently wrong rather than merely slow.
     */
    AccessibilityNodeInfo currentRoot() {
        AccessibilityNodeInfo fresh = null;
        try {
            fresh = getRootInActiveWindow();
        } catch (Throwable ignored) {
        }
        if (fresh != null) return fresh;
        return lastRoot;
    }

    /**
     * The app-visible frame in pixels: full display size MINUS the system bars.
     *
     * `uiautomator dump` reports the app frame (measured: 1536x2524 on a
     * 1536x2560 device), while a raw AccessibilityNodeInfo root reports the full
     * display. The plugin turns tree bounds into normalized tap coordinates, so
     * the taller number would skew every tap. See TreeDumper.clampToAppFrame for
     * the full consequence.
     */
    int[] appFrame() {
        // The APP frame is what uiautomator reports as the hierarchy root bounds
        // (measured: 2560x1500 in landscape), and it is NOT the display size
        // (2560x1536). The plugin divides tap pixels by this value, so getting it
        // wrong shifts every tap.
        //
        // Two earlier attempts failed:
        //   1. WindowMetrics.getBounds()      -> 2560x1536 (full display)
        //   2. minus systemBars insets (96)   -> 2560x1440 (60 px too short; the
        //      landscape status bar is drawn OVER the app, it does not shrink it)
        //   3. Configuration.windowConfiguration is a HIDDEN field, unavailable
        //      against the public SDK.
        //
        // This reads the ACTIVE WINDOW's own frame through the public
        // AccessibilityService#getWindows() API — the frame the window manager
        // actually gave the app, so it cannot drift from what the app sees.
        try {
            java.util.List<android.view.accessibility.AccessibilityWindowInfo> windows = getWindows();
            if (windows != null) {
                for (android.view.accessibility.AccessibilityWindowInfo w : windows) {
                    if (w == null) continue;
                    if (w.getType() != android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION) continue;
                    android.graphics.Rect b = new android.graphics.Rect();
                    w.getBoundsInScreen(b);
                    if (b.width() > 0 && b.height() > 0) {
                        return new int[] { b.width(), b.height() };
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        try {
            android.view.WindowManager wm =
                (android.view.WindowManager) getSystemService(WINDOW_SERVICE);
            if (wm != null) {
                android.util.DisplayMetrics dm = new android.util.DisplayMetrics();
                wm.getDefaultDisplay().getRealMetrics(dm);
                return new int[] { dm.widthPixels, dm.heightPixels };
            }
        } catch (Throwable ignored) {
        }
        return new int[] { 0, 0 };
    }

    int rotation() {
        try {
            android.view.WindowManager wm =
                (android.view.WindowManager) getSystemService(WINDOW_SERVICE);
            if (wm != null) {
                // uiautomator writes the Surface.ROTATION_* ENUM (0/1/2/3), NOT degrees.
                // Verified against a real dump: landscape is "rotation=1", while a
                // degrees value would be "rotation=90". The plugin parses this as a
                // number, so the two must agree.
                int r = wm.getDefaultDisplay().getRotation();
                if (r >= 0 && r <= 3) return r;
            }
        } catch (Throwable ignored) {
        }
        return 0;
    }
}