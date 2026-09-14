package com.beiway1145.dshbridge;

import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * Serializes an AccessibilityNodeInfo tree into the SAME XML dialect
 * `uiautomator dump` emits.
 *
 * Why the format must match: the DSH plugin already parses that dialect
 * (src/uitree.ts: extractHierarchyXml + parseUiTree). Reusing it makes the
 * bridge a pure TRANSPORT swap — no parser, no tool contract and no test
 * fixture in the plugin changes. Any attribute this class omits or renames
 * would silently degrade every tree-reading tool, so the attribute set and
 * order mirror uiautomator's own emitter.
 */
final class TreeDumper {

    private final StringBuilder out = new StringBuilder(64 * 1024);
    private int nodes = 0;
    private int appWidth = 0;
    private int appHeight = 0;

    /**
     * @param rotation display rotation in degrees, as uiautomator reports it
     * @return a complete `<hierarchy>` document
     */
    static String dump(AccessibilityNodeInfo root, int rotation, int appWidth, int appHeight) {
        TreeDumper d = new TreeDumper();
        d.appWidth = appWidth;
        d.appHeight = appHeight;
        d.out.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>");
        d.out.append("<hierarchy rotation=\"").append(rotation).append("\">");
        if (root != null) d.node(root, 0);
        d.out.append("</hierarchy>");
        return d.out.toString();
    }

    /** Node count of the last {@link #dump} call on this instance (diagnostics only). */
    int nodeCount() { return nodes; }

    private void node(AccessibilityNodeInfo n, int index) {
        nodes++;
        Rect b = new Rect();
        n.getBoundsInScreen(b);
        clampToAppFrame(b);
        out.append("<node")
           .append(" index=\"").append(index).append("\"")
           .append(" text=\"").append(esc(n.getText())).append("\"")
           .append(" resource-id=\"").append(esc(n.getViewIdResourceName())).append("\"")
           .append(" class=\"").append(esc(n.getClassName())).append("\"")
           .append(" package=\"").append(esc(n.getPackageName())).append("\"")
           .append(" content-desc=\"").append(esc(n.getContentDescription())).append("\"")
           .append(" checkable=\"").append(n.isCheckable() ? "true" : "false").append("\"")
           .append(" checked=\"").append(n.isChecked() ? "true" : "false").append("\"")
           .append(" clickable=\"").append(n.isClickable() ? "true" : "false").append("\"")
           .append(" enabled=\"").append(n.isEnabled() ? "true" : "false").append("\"")
           .append(" focusable=\"").append(n.isFocusable() ? "true" : "false").append("\"")
           .append(" focused=\"").append(n.isFocused() ? "true" : "false").append("\"")
           .append(" scrollable=\"").append(n.isScrollable() ? "true" : "false").append("\"")
           .append(" long-clickable=\"").append(n.isLongClickable() ? "true" : "false").append("\"")
           .append(" password=\"").append(n.isPassword() ? "true" : "false").append("\"")
           .append(" selected=\"").append(n.isSelected() ? "true" : "false").append("\"")
           .append(" bounds=\"[").append(b.left).append(",").append(b.top)
           .append("][").append(b.right).append(",").append(b.bottom).append("]\"");

        final int children = n.getChildCount();
        if (children <= 0) {
            out.append(" />");
            return;
        }
        out.append(">");
        for (int i = 0; i < children; i++) {
            AccessibilityNodeInfo c = childAt(n, i);
            if (c != null) node(c, i);
        }
        out.append("</node>");
    }

    /**
     * Clamp a rect to the app-visible frame.
     *
     * WHY THIS EXISTS — measured on a MIUI 14 tablet:
     * a root AccessibilityNodeInfo reports the FULL display (1536x2560), while
     * `uiautomator dump` reports the APP frame (1536x2524, i.e. minus the 36 px
     * system bar). The plugin derives its screen size from the tree roots
     * (src/uitree.ts: screenBoundsOf -> max(x+w, y+h)) and the tap tools divide
     * pixel centers by that value to get normalized 0..1 coordinates. Leaving
     * the taller number in place would scale EVERY tap by 2524/2560 = 0.986 and
     * land it up to 36 px high — near the bottom of the screen that is the
     * difference between hitting a button and missing it.
     *
     * Only the top-level container needs this (children already carry their real
     * on-screen rects), but clamping unconditionally is harmless because no
     * genuine child can extend past the app frame.
     */
    private void clampToAppFrame(Rect r) {
        if (appWidth <= 0 || appHeight <= 0) return;
        if (r.left < 0) r.left = 0;
        if (r.top < 0) r.top = 0;
        if (r.right > appWidth) r.right = appWidth;
        if (r.bottom > appHeight) r.bottom = appHeight;
        if (r.right < r.left) r.right = r.left;
        if (r.bottom < r.top) r.bottom = r.top;
    }

    /**
     * {@code getChild} returns null for a stale/virtual slot. uiautomator keeps
     * the ORDINAL of the slot it asked for, so a skipped slot leaves the next
     * sibling's index as its real position rather than a compacted one — this
     * is what keeps {@code index} comparable between the two backends.
     */
    private static AccessibilityNodeInfo childAt(AccessibilityNodeInfo n, int i) {
        try {
            return n.getChild(i);
        } catch (Throwable t) {
            return null;
        }
    }

    private static String esc(CharSequence cs) {
        if (cs == null) return "";
        String s = cs.toString();
        if (s.isEmpty()) return "";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '&':  sb.append("&amp;");  break;
                case '<':  sb.append("&lt;");   break;
                case '>':  sb.append("&gt;");   break;
                case '"':  sb.append("&quot;"); break;
                case '\n': sb.append("&#10;"); break;
                case '\r': break;
                default:   sb.append(ch);
            }
        }
        return sb.toString();
    }
}