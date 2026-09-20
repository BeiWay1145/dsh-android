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

    /**
     * Bumped whenever the window content or focus changes.
     *
     * This is proposal 2's core: the service is ALREADY subscribed to
     * AccessibilityEvent, so it can tell a caller "nothing changed since
     * revision N" for the cost of a counter read — no tree walk, no
     * serialization, and no host-side fingerprint round trip. A repeat read of
     * an idle screen therefore costs ~1 ms instead of the ~130 ms the
     * host-side screen fingerprint needs, or 2.4 s for a fresh uiautomator dump.
     *
     * Deliberately coarse: ANY relevant event invalidates. A false "changed"
     * only costs one extra dump, while a false "unchanged" would serve a stale
     * tree to an agent about to act on it — so the counter errs toward
     * invalidating, and `currentRoot()` re-reads the live window regardless.
     */
    private final java.util.concurrent.atomic.AtomicLong revision =
        new java.util.concurrent.atomic.AtomicLong(1);

    /** The current content revision. */
    long revision() {
        return revision.get();
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        Log.i(TAG, "accessibility service connected");
        // Always (re)establish: a reconnect after an unbind must not be left
        // without a listener. start() is idempotent from the caller's side
        // because a fresh SocketServer owns a fresh thread.
        // stop() now RELEASES the abstract name (it closes through a local
        // reference and joins the accept loop) before it returns, so the bind
        // below does not race the previous instance. Without that, HarmonyOS's
        // frequent unbind/rebind cycles produced 'Address already in use' on
        // every attempt and seconds of unavailability -- measured 4.0 s for one
        // rebind, 11.0 s across five.
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
        // Invalidate on every event type we subscribe to. See revision() for why
        // this errs toward a false "changed".
        revision.incrementAndGet();
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
        // Report the APP FRAME — the same thing `uiautomator dump` puts on its
        // hierarchy root — so the two backends are indistinguishable to callers.
        //
        // MEASURED on a MIUI 14 tablet (landscape): display is 2560x1536 and
        // uiautomator reports 2560x1500, i.e. the 36 px navigation bar is
        // excluded while the 60 px status bar is NOT (MIUI lays the app window
        // out in-screen under the status bar, so that bar overlays rather than
        // insets). Three earlier attempts got this wrong:
        //   1. getCurrentWindowMetrics().getBounds()        -> 1536 (full display)
        //   2. minus systemBars() insets (60 + 36)          -> 1440 (60 too small,
        //      it subtracted a bar that does not inset)
        //   3. the TYPE_APPLICATION window from getWindows()-> 1536 (MIUI reports
        //      the window frame as the full display for the same reason)
        // Subtracting ONLY the navigation-bar insets matches, and is derived from
        // the live inset rather than a hard-coded number, so it follows the device
        // into portrait and into gesture-navigation where the bar is a different
        // size.
        try {
            android.view.WindowManager wm =
                (android.view.WindowManager) getSystemService(WINDOW_SERVICE);
            if (wm != null && android.os.Build.VERSION.SDK_INT >= 30) {
                android.view.WindowMetrics metrics = wm.getCurrentWindowMetrics();
                android.graphics.Rect bounds = metrics.getBounds();
                int w = bounds.width();
                int h = bounds.height();
                try {
                    android.view.WindowInsets insets = metrics.getWindowInsets();
                    android.graphics.Insets nav = insets.getInsetsIgnoringVisibility(
                        android.view.WindowInsets.Type.navigationBars());
                    w -= nav.left + nav.right;
                    h -= nav.top + nav.bottom;
                } catch (Throwable ignored) {
                }
                if (w > 0 && h > 0) return new int[] { w, h };
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