package com.truckingos.tracker;

import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.TextView;

/**
 * Draws the floating HOS clock card (TYPE_APPLICATION_OVERLAY) and keeps
 * it on screen independently of the app's activity: closing the app does
 * not stop this service, so the card stays until the driver dismisses it
 * (the card's x), the Tracker settings switch it off (plugin hide ->
 * stopService), or the system kills the process.
 *
 * The card can be dragged anywhere on the screen by touch; the position
 * is saved on the phone (SharedPreferences) when a drag ends and restored
 * when the service starts again, so it stays where the driver put it
 * across restarts and reboots. A tap is still a tap: the drag only starts
 * once the finger moves past the system's touch slop, and a tap on the
 * card's x still dismisses it. The position is clamped so the card can
 * never be dragged (or restored) partly off screen.
 *
 * Display only - no duty controls, nothing that changes a log. Values
 * come from HosOverlayState (server-computed); between the web layer's
 * 30-second polls the card counts down by wall clock from the anchored
 * server answer, and every poll re-anchors it.
 */
public class HosOverlayService extends Service {
    /** Where the card's position is saved (x/y in WindowManager params). */
    static final String PREFS_NAME = "hos_overlay_position";
    static final String KEY_X = "x";
    static final String KEY_Y = "y";
    /** The first position, before the driver has ever moved the card. */
    private static final int DEFAULT_X = 16;
    private static final int DEFAULT_Y = 96;
    /** Fallback card size (dp) for clamping before the first layout pass. */
    private static final int FALLBACK_CARD_WIDTH_DP = 150;
    private static final int FALLBACK_CARD_HEIGHT_DP = 170;

    private WindowManager windowManager;
    private WindowManager.LayoutParams layoutParams;
    private SharedPreferences positionPrefs;
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

    // Drag state (main thread only - the touch listener runs there).
    private int touchSlopPx;
    private boolean dragging;
    private int dragDownRawX;
    private int dragDownRawY;
    private int dragStartX;
    private int dragStartY;

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
        layoutParams = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        layoutParams.gravity = Gravity.TOP | Gravity.END;
        // Restore where the driver left the card; first time, the default spot.
        positionPrefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        int[] restored = HosOverlayDrag.clampToScreen(
                positionPrefs.getInt(KEY_X, DEFAULT_X),
                positionPrefs.getInt(KEY_Y, DEFAULT_Y),
                displayWidthPx(), displayHeightPx(),
                dpToPx(FALLBACK_CARD_WIDTH_DP), dpToPx(FALLBACK_CARD_HEIGHT_DP));
        layoutParams.x = restored[0];
        layoutParams.y = restored[1];
        touchSlopPx = ViewConfiguration.get(this).getScaledTouchSlop();
        card.setOnTouchListener(this::onCardTouch);
        try {
            windowManager.addView(card, layoutParams);
        } catch (RuntimeException e) {
            // Permission revoked between the plugin's check and now: draw
            // nothing rather than crash; the next poll retries.
            stopSelf();
            return;
        }
        tickHandler.post(tick);
    }

    /**
     * Drag the card by touch. The listener takes the gesture on ACTION_DOWN
     * so the MOVE events arrive here; a tap (no real movement) is handed
     * to the close button when it lands on it, so the x still works.
     */
    private boolean onCardTouch(View v, MotionEvent event) {
        int rawX = (int) event.getRawX();
        int rawY = (int) event.getRawY();
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                dragging = false;
                dragDownRawX = rawX;
                dragDownRawY = rawY;
                dragStartX = layoutParams.x;
                dragStartY = layoutParams.y;
                return true;
            case MotionEvent.ACTION_MOVE:
                if (!dragging && HosOverlayDrag.isDrag(
                        dragDownRawX, dragDownRawY, rawX, rawY, touchSlopPx)) {
                    dragging = true;
                }
                if (dragging) {
                    int[] pos = HosOverlayDrag.dragTo(
                            dragStartX, dragStartY, dragDownRawX, dragDownRawY,
                            rawX, rawY,
                            displayWidthPx(), displayHeightPx(),
                            cardWidthPx(), cardHeightPx());
                    layoutParams.x = pos[0];
                    layoutParams.y = pos[1];
                    windowManager.updateViewLayout(card, layoutParams);
                }
                return true;
            case MotionEvent.ACTION_UP:
                if (dragging) {
                    savePosition();
                } else {
                    // A tap, not a drag: if it landed on the x, dismiss as before.
                    View close = card.findViewById(R.id.hos_close);
                    if (close != null && isTapOnView(close, event)) {
                        close.performClick();
                    }
                }
                dragging = false;
                return true;
            case MotionEvent.ACTION_CANCEL:
                if (dragging) {
                    savePosition();
                }
                dragging = false;
                return true;
            default:
                return false;
        }
    }

    private void savePosition() {
        positionPrefs.edit()
                .putInt(KEY_X, layoutParams.x)
                .putInt(KEY_Y, layoutParams.y)
                .apply();
    }

    private static boolean isTapOnView(View view, MotionEvent event) {
        int[] loc = new int[2];
        view.getLocationOnScreen(loc);
        float x = event.getRawX();
        float y = event.getRawY();
        return x >= loc[0] && x < loc[0] + view.getWidth()
                && y >= loc[1] && y < loc[1] + view.getHeight();
    }

    private int displayWidthPx() {
        return getResources().getDisplayMetrics().widthPixels;
    }

    private int displayHeightPx() {
        return getResources().getDisplayMetrics().heightPixels;
    }

    /** Measured card size once laid out; the layout minimum before that. */
    private int cardWidthPx() {
        return card.getWidth() > 0 ? card.getWidth() : dpToPx(FALLBACK_CARD_WIDTH_DP);
    }

    private int cardHeightPx() {
        return card.getHeight() > 0 ? card.getHeight() : dpToPx(FALLBACK_CARD_HEIGHT_DP);
    }

    private int dpToPx(int dp) {
        DisplayMetrics dm = getResources().getDisplayMetrics();
        return Math.round(dp * dm.density);
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
