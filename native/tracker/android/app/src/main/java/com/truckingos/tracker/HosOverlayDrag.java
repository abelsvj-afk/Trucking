package com.truckingos.tracker;

/**
 * Pure drag math for the floating HOS clock (HosOverlayService).
 *
 * No Android imports, so it is unit-testable on the host JVM
 * (HosOverlayDragTest). The service owns the touch handling and the
 * saved position; this class only answers "where does the card go".
 *
 * WindowManager gravity is TOP | END, so:
 * - x grows LEFTWARD (a finger moving right makes x smaller);
 * - y grows DOWNWARD (a finger moving down makes y larger).
 *
 * Every result is clamped so the card stays fully on screen: the driver
 * can never drag the clock somewhere he cannot reach it again.
 */
public final class HosOverlayDrag {
    private HosOverlayDrag() {}

    /** True once the finger has moved far enough that this is a drag, not a tap. */
    public static boolean isDrag(int downRawX, int downRawY, int rawX, int rawY, int slopPx) {
        return Math.max(Math.abs(rawX - downRawX), Math.abs(rawY - downRawY)) > slopPx;
    }

    /**
     * LayoutParams x/y for gravity TOP|END after a drag from
     * (downRawX, downRawY) to (rawX, rawY), starting from (startX, startY).
     * Returns {x, y}, clamped to the screen.
     */
    public static int[] dragTo(int startX, int startY,
                               int downRawX, int downRawY, int rawX, int rawY,
                               int displayWidthPx, int displayHeightPx,
                               int cardWidthPx, int cardHeightPx) {
        int x = startX - (rawX - downRawX);
        int y = startY + (rawY - downRawY);
        return clampToScreen(x, y, displayWidthPx, displayHeightPx, cardWidthPx, cardHeightPx);
    }

    /**
     * Clamp a position (dragged or restored from storage) so the card
     * stays fully on screen: x in [0, displayWidth - cardWidth],
     * y in [0, displayHeight - cardHeight]. A saved position from a
     * bigger screen (or a rotated one) is pulled back inside.
     */
    public static int[] clampToScreen(int x, int y,
                                      int displayWidthPx, int displayHeightPx,
                                      int cardWidthPx, int cardHeightPx) {
        int maxX = Math.max(0, displayWidthPx - Math.max(0, cardWidthPx));
        int maxY = Math.max(0, displayHeightPx - Math.max(0, cardHeightPx));
        return new int[]{
                Math.min(Math.max(x, 0), maxX),
                Math.min(Math.max(y, 0), maxY),
        };
    }
}
