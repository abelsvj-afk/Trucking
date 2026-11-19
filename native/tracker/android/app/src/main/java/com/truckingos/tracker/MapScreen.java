package com.truckingos.tracker;

/**
 * Pure helpers for MapActivity — no Android imports, so they are
 * unit-tested on the host JVM (MapScreenTest).
 */
public final class MapScreen {
    private MapScreen() {}

    /** The drive map on the saved server: https://host[/path]/smart-path/drive. */
    public static String mapUrl(String server) {
        String base = server == null ? "" : server.trim();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base + "/smart-path/drive";
    }

    /** Only the saved server's own host loads inside the app; everything else is refused. */
    public static boolean isOwnServer(String host, String serverHost) {
        return host != null && serverHost != null && !serverHost.isEmpty() && host.equalsIgnoreCase(serverHost);
    }

    public static String noServerHtml() {
        return "<html><body style=\"font-family:sans-serif;padding:24px;background:#111827;color:#fff\">"
                + "<h2>No server saved</h2><p>Open the Tracker's Settings, save the server address and key, then open the map again.</p>"
                + "</body></html>";
    }
}
