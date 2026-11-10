package com.truckingos.tracker;

import android.app.Service;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

/**
 * Draws the floating HOS clock card (TYPE_APPLICATION_OVERLAY) and keeps
 * it on screen independently of the app's activity: closing the app does
 * not stop this service, so the card stays until the driver dismisses it
 * (the card's x), the Tracker settings switch it off (plugin hide ->
 * stopService), or the system kills the process.
 *
 * Display only - no duty controls, nothing that changes a log. Values
 * come from HosOverlayState (server-computed); between the web layer's
 * 30-second polls the card counts down by wall clock from the anchored
 * server answer, and every poll re-anchors it.
 */
public class HosOverlayService extends Service {
    private WindowManager windowManager;
    private View card;
    private TextView statusView;
    private final TextView[] valueViews = new TextView[4];
    private final TextView[] labelViews = new TextView[4];
    private final Handler tickHandler = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            render();
            tickHandler.postDelayed(this, 1000L);
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        card = LayoutInflater.from(this).inflate(R.layout.hos_overlay, null);
        statusView = card.findViewById(R.id.hos_status);
        valueViews[0] = card.findViewById(R.id.hos_value_1);
        valueViews[1] = card.findViewById(R.id.hos_value_2);
        valueViews[2] = card.findViewById(R.id.hos_value_3);
        valueViews[3] = card.findViewById(R.id.hos_value_4);
        labelViews[0] = card.findViewById(R.id.hos_label_1);
        labelViews[1] = card.findViewById(R.id.hos_label_2);
        labelViews[2] = card.findViewById(R.id.hos_label_3);
        labelViews[3] = card.findViewById(R.id.hos_label_4);
        card.findViewById(R.id.hos_close).setOnClickListener(v -> stopSelf());

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.END;
        params.x = 16;
        params.y = 96;
        try {
            windowManager.addView(card, params);
        } catch (RuntimeException e) {
            // Permission revoked between the plugin's check and now: draw
            // nothing rather than crash; the next poll retries.
            stopSelf();
            return;
        }
        tickHandler.post(tick);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        render();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        tickHandler.removeCallbacks(tick);
        if (card != null && windowManager != null) {
            try {
                windowManager.removeView(card);
            } catch (RuntimeException ignored) {
                // already detached
            }
        }
        super.onDestroy();
    }

    private void render() {
        if (card == null) return;
        if (!HosOverlayState.hasLines()) {
            statusView.setText("HOS - no logs yet");
            for (int i = 0; i < 4; i++) {
                labelViews[i].setText("");
                valueViews[i].setText("");
            }
            return;
        }
        statusView.setText("HOS - " + HosOverlayState.statusText());
        long elapsedSinceAnchor = SystemClock.elapsedRealtime() - HosOverlayState.anchorElapsedMs();
        if (elapsedSinceAnchor < 0) elapsedSinceAnchor = 0;
        HosOverlayState.Line[] lines = HosOverlayState.lines();
        for (int i = 0; i < 4; i++) {
            if (i < lines.length) {
                HosOverlayState.Line line = lines[i];
                long remaining = Math.max(0L, line.remainingMs - elapsedSinceAnchor);
                labelViews[i].setText(line.label);
                valueViews[i].setText(formatClock(remaining));
                valueViews[i].setTextColor(colorFor(line.tone, remaining));
            } else {
                labelViews[i].setText("");
                valueViews[i].setText("");
            }
        }
    }

    private int colorFor(String tone, long remainingMs) {
        if (remainingMs <= 0 || "expired".equals(tone)) return 0xFFE5484D; // danger red
        if ("warn".equals(tone)) return 0xFFF5B544; // amber warning
        return 0xFFFFFFFF; // white
    }

    /** H:MM countdown text (8h 5m -> "8:05"). */
    static String formatClock(long ms) {
        long totalSec = Math.max(0L, ms / 1000L);
        long h = totalSec / 3600L;
        long m = (totalSec % 3600L) / 60L;
        return h + ":" + (m < 10 ? "0" : "") + m;
    }
}
