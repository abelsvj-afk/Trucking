package com.truckingos.tracker;

/**
 * The latest clock values for the floating HOS overlay, exactly as the
 * server computed them (POST /api/v1/position/clocks - the one HOS read;
 * this app never computes HOS). Written by HosOverlayPlugin from the web
 * layer's polls, read by HosOverlayService when it (re)anchors its card.
 *
 * Each line carries the remaining milliseconds AT the anchor instant
 * (elapsedRealtime), so the service can count the display down between
 * the web layer's 30-second refreshes; every new poll re-anchors.
 */
public final class HosOverlayState {
    public static final class Line {
        public final String label;
        public final long remainingMs;
        public final String tone;

        Line(String label, long remainingMs, String tone) {
            this.label = label;
            this.remainingMs = remainingMs;
            this.tone = tone;
        }
    }

    private static volatile String statusText = "";
    private static volatile Line[] lines = new Line[0];
    private static volatile long anchorElapsedMs = 0L;

    private HosOverlayState() {}

    public static synchronized void set(String status, Line[] newLines, long anchorElapsed) {
        statusText = status != null ? status : "";
        lines = newLines != null ? newLines : new Line[0];
        anchorElapsedMs = anchorElapsed;
    }

    public static String statusText() {
        return statusText;
    }

    public static Line[] lines() {
        return lines;
    }

    public static long anchorElapsedMs() {
        return anchorElapsedMs;
    }

    public static boolean hasLines() {
        return lines.length > 0;
    }
}
