package com.truckingos.tracker;

// The Tracker's own background service (owner 2026-11-16: "only tracking when I open it", and the
// notification was gone). The old path used the background-geolocation plugin, whose service stops itself
// as soon as the app's screen is unbound (onUnbind -> stopSelf) and which handed every fix to the app's web
// page to send - so with the app closed nothing was read and nothing was sent.
//
// This service does all of it natively, independent of the app being open:
//  - a FOREGROUND service of type "location" with a permanent notification (Android requires the notification;
//    it is also how he can see tracking is on);
//  - reads GPS through Google's fused location provider;
//  - queues fixes in SharedPreferences (max 500, 24 h) and POSTs them to <server>/api/v1/position/feed with
//    the device key, every 30 s, with backoff on failure; 401 stops tracking and says so;
//  - START_STICKY, and swiping the app away does NOT stop it - only the Stop button does.
// Same rules as www/feed-queue.js. The key is never written to the log. Paper-log helper, not an ELD.

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.Date;

public class TrackerService extends Service {
    public static final String PREFS = "tracker_native";
    static final String CHANNEL_ID = "tracking";
    static final int NOTIFICATION_ID = 4711;
    static final int MAX_QUEUE = 3000; // ~4 h of 5-second fixes through a dead zone
    static final int MAX_BATCH = 60;
    static final long MAX_AGE_MS = 24L * 3600 * 1000;
    static final long FLUSH_EVERY_MS = 30_000;
    static final long[] BACKOFF_MS = {15_000, 30_000, 60_000, 120_000, 300_000};
    static final int LOG_MAX = 60;
    /** Must stay well under the server's 20 s fix-gap reset (lib/sustained-motion.ts). */
    static final long FIX_EVERY_MS = 5_000;

    private FusedLocationProviderClient client;
    private HandlerThread netThread;
    private Handler net;
    private int failures = 0;
    private final LocationCallback callback = new LocationCallback() {
        @Override
        public void onLocationResult(LocationResult result) {
            for (Location l : result.getLocations()) enqueue(l);
        }
    };

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, TrackerService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    public static void stop(Context ctx) {
        prefs(ctx).edit().putBoolean("running", false).apply();
        ctx.stopService(new Intent(ctx, TrackerService.class));
    }

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        netThread = new HandlerThread("tracker-net");
        netThread.start();
        net = new Handler(netThread.getLooper());
        client = LocationServices.getFusedLocationProviderClient(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = notification("Reporting your position so your log can keep up with the truck.");
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(NOTIFICATION_ID, n);
        } catch (Exception e) {
            log("ERROR", "Android refused to start background tracking: " + e.getMessage() + " - open the Tracker and allow Location and Notifications.");
            prefs(this).edit().putBoolean("running", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        prefs(this).edit().putBoolean("running", true).apply();
        try {
            // ELD-style automatic switching runs on the server from these fixes (services/fleet/auto-motion.ts):
            // Driving after 60 s sustained at 5 mph+, On Duty after 6 min stopped. Its motion detector forgets
            // everything after a 20-second gap between fixes (lib/sustained-motion.ts FIX_GAP_RESET_MS), and the
            // stop side needs fixes while PARKED. So: a fix every 5 s, moving or not - no distance filter.
            LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, FIX_EVERY_MS)
                .setMinUpdateIntervalMillis(FIX_EVERY_MS)
                .setMaxUpdateDelayMillis(0)
                .setMinUpdateDistanceMeters(0)
                .setWaitForAccurateLocation(false)
                .build();
            client.removeLocationUpdates(callback);
            client.requestLocationUpdates(req, callback, Looper.getMainLooper());
            log("INFO", "Background tracking started - it keeps running with the app closed.");
        } catch (SecurityException e) {
            log("ERROR", "Location permission is off - in phone Settings -> Apps -> Trucking OS Tracker -> Permissions, allow Location.");
            stop(this);
            return START_NOT_STICKY;
        }
        net.removeCallbacksAndMessages(null);
        net.post(this::flushLoop);
        return START_STICKY;
    }

    // Swiping the app away must NOT stop tracking (the old plugin's service stopped here).
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        client.removeLocationUpdates(callback);
        if (net != null) net.removeCallbacksAndMessages(null);
        if (netThread != null) netThread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification notification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Tracking", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shows while the Tracker reports your position.");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Trucking OS Tracker")
            .setContentText(text)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pi)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    private void updateNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTIFICATION_ID, notification(text));
    }

    // ---- queue ------------------------------------------------------------------------------------------

    private synchronized void enqueue(Location l) {
        try {
            JSONObject fix = new JSONObject();
            fix.put("lat", l.getLatitude());
            fix.put("lng", l.getLongitude());
            fix.put("at", l.getTime() > 0 ? l.getTime() : System.currentTimeMillis());
            if (l.hasAccuracy()) fix.put("accuracy_m", Math.max(0, l.getAccuracy()));
            if (l.hasBearing()) fix.put("heading_deg", l.getBearing());
            JSONArray q = readQueue(this);
            JSONArray kept = new JSONArray();
            long now = System.currentTimeMillis();
            for (int i = 0; i < q.length(); i++) {
                JSONObject f = q.getJSONObject(i);
                if (now - f.getLong("at") <= MAX_AGE_MS) kept.put(f);
            }
            kept.put(fix);
            while (kept.length() > MAX_QUEUE) kept.remove(0);
            prefs(this).edit().putString("queue", kept.toString()).putLong("lastFixAt", now).apply();
        } catch (Exception ignored) {
            // a fix that can't be stored is skipped; the next one arrives within seconds
        }
    }

    static JSONArray readQueue(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString("queue", "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    // ---- sending ----------------------------------------------------------------------------------------

    private void flushLoop() {
        long delay = FLUSH_EVERY_MS;
        try {
            delay = flushOnce();
        } catch (Exception e) {
            log("ERROR", "Send failed: " + e.getMessage());
        }
        if (prefs(this).getBoolean("running", false)) net.postDelayed(this::flushLoop, delay);
    }

    /** Sends one batch; returns how long to wait before the next try. */
    private long flushOnce() throws Exception {
        SharedPreferences p = prefs(this);
        String server = p.getString("server", "");
        String key = p.getString("key", "");
        JSONArray q;
        synchronized (this) {
            q = readQueue(this);
        }
        if (q.length() == 0 || server.isEmpty() || key.isEmpty()) return FLUSH_EVERY_MS;
        // Audit F-019: after a refused batch, resend those positions ONE AT A TIME, so only
        // a position the server itself refuses is dropped - never the good ones beside it.
        int oneByOne = p.getInt("oneByOneLeft", 0);
        int count = oneByOne > 0 ? 1 : Math.min(MAX_BATCH, q.length());
        JSONArray batch = new JSONArray();
        for (int i = 0; i < count; i++) batch.put(q.get(i));
        String url = server.replaceAll("/+$", "") + "/api/v1/position/feed";
        HttpURLConnection c = null;
        int status;
        String body;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(20_000);
            c.setReadTimeout(20_000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Authorization", "Bearer " + key);
            try (OutputStream os = c.getOutputStream()) {
                os.write(new JSONObject().put("fixes", batch).toString().getBytes(StandardCharsets.UTF_8));
            }
            status = c.getResponseCode();
            body = read(status >= 400 ? c.getErrorStream() : c.getInputStream());
        } catch (Exception e) {
            failures++;
            String why = "No answer from the server - " + e.getClass().getSimpleName() + ": " + e.getMessage();
            log("ERROR", why + " (" + q.length() + " waiting)");
            p.edit().putString("lastError", why).apply();
            updateNotification("Can't reach the server - " + q.length() + " positions waiting, will keep trying.");
            return backoff();
        } finally {
            if (c != null) c.disconnect();
        }
        if (status == 401) {
            String why = "The server refused this key (HTTP 401). It may have been revoked - make a new one in Trucking OS, then put it in the Tracker's Settings.";
            log("ERROR", why + " Tracking stopped.");
            p.edit().putString("lastError", why).apply();
            stop(this);
            return FLUSH_EVERY_MS;
        }
        String type = c.getContentType() == null ? "" : c.getContentType();
        if (status == 400 && count > 1) {
            log("ERROR", "Server answered HTTP 400 for " + count + " positions - resending them one at a time so only a refused one is dropped: " + trim(body));
            p.edit().putInt("oneByOneLeft", count).apply();
            return 1_000;
        }
        if (status >= 200 && status < 300 && !type.contains("text/html") || status == 400) {
            synchronized (this) {
                JSONArray now = readQueue(this);
                JSONArray rest = new JSONArray();
                for (int i = count; i < now.length(); i++) rest.put(now.get(i));
                p.edit().putString("queue", rest.toString()).apply();
            }
            if (status == 400) log("ERROR", "Server refused one position (HTTP 400), dropped it: " + trim(body));
            if (oneByOne > 0) p.edit().putInt("oneByOneLeft", oneByOne - 1).apply();
            if (failures > 0) log("INFO", "Connection restored - reports are being accepted again.");
            failures = 0;
            p.edit().putLong("lastSentAt", System.currentTimeMillis()).remove("lastError").apply();
            updateNotification("Reporting your position. Last sent " + DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date()) + ".");
            return count == MAX_BATCH ? 1_000 : FLUSH_EVERY_MS;
        }
        failures++;
        String why = "Server answered HTTP " + status + (type.contains("text/html") ? " with a web page, not the position feed - check the server URL in Settings." : " - " + trim(body));
        log("ERROR", why);
        p.edit().putString("lastError", why).apply();
        return backoff();
    }

    private long backoff() {
        return BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1];
    }

    private static String read(InputStream in) {
        if (in == null) return "";
        try (InputStream s = in) {
            return new String(s.readAllBytes(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private static String trim(String s) {
        String t = s == null ? "" : s.replaceAll("\\s+", " ").trim();
        return t.length() > 200 ? t.substring(0, 200) : t;
    }

    // ---- log --------------------------------------------------------------------------------------------

    synchronized void log(String level, String message) {
        log(this, level, message);
    }

    static synchronized void log(Context ctx, String level, String message) {
        SharedPreferences p = prefs(ctx);
        String key = p.getString("key", "");
        String clean = key.isEmpty() ? message : message.replace(key, "tdv_[hidden]");
        clean = clean.replaceAll("tdv_[A-Za-z0-9_-]{12,}", "tdv_[hidden]");
        try {
            JSONArray lines = new JSONArray(p.getString("log", "[]"));
            lines.put(DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM).format(new Date()) + "  " + level + "  " + clean);
            while (lines.length() > LOG_MAX) lines.remove(0);
            p.edit().putString("log", lines.toString()).apply();
        } catch (Exception ignored) {
            // the log is an aid; never fails tracking
        }
        android.util.Log.println("ERROR".equals(level) ? android.util.Log.ERROR : android.util.Log.INFO, "tracker", clean);
    }
}
