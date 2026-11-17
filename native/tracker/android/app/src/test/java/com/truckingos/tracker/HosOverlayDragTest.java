package com.truckingos.tracker;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Drag math for the floating HOS clock (HosOverlayDrag). Pure JVM test —
 * no Android framework, no emulator. The screen here is 1080x1920 and
 * the card is 400x500, so x ranges 0..680 and y ranges 0..1420.
 */
public class HosOverlayDragTest {
    private static final int W = 1080;
    private static final int H = 1920;
    private static final int CARD_W = 400;
    private static final int CARD_H = 500;
    private static final int SLOP = 16;

    @Test
    public void dragRightMovesCardRight() {
        // Gravity END: x grows leftward, so a finger moving right (dx +200)
        // makes x SMALLER. Card starts at x=16, y=96.
        assertArrayEquals(new int[]{0, 96},
                HosOverlayDrag.dragTo(16, 96, 500, 500, 700, 500, W, H, CARD_W, CARD_H));
    }

    @Test
    public void dragLeftMovesCardLeft() {
        assertArrayEquals(new int[]{216, 96},
                HosOverlayDrag.dragTo(16, 96, 500, 500, 300, 500, W, H, CARD_W, CARD_H));
    }

    @Test
    public void dragDownMovesCardDown() {
        assertArrayEquals(new int[]{16, 296},
                HosOverlayDrag.dragTo(16, 96, 500, 500, 500, 700, W, H, CARD_W, CARD_H));
    }

    @Test
    public void dragUpMovesCardUp() {
        assertArrayEquals(new int[]{16, 0},
                HosOverlayDrag.dragTo(16, 96, 500, 500, 500, 400, W, H, CARD_W, CARD_H));
    }

    @Test
    public void noMovementKeepsPosition() {
        assertArrayEquals(new int[]{16, 96},
                HosOverlayDrag.dragTo(16, 96, 500, 500, 500, 500, W, H, CARD_W, CARD_H));
    }

    @Test
    public void cardCannotLeaveRightEdge() {
        // Finger drags far right: x would go to -984, clamped to 0.
        assertArrayEquals(new int[]{0, 96},
                HosOverlayDrag.dragTo(16, 96, 500, 500, 1500, 500, W, H, CARD_W, CARD_H));
    }

    @Test
    public void cardCannotLeaveLeftEdge() {
        // Finger drags far left: x would go to 1516, clamped to 680 (1080-400).
        assertArrayEquals(new int[]{680, 96},
                HosOverlayDrag.dragTo(16, 96, 500, 500, -1000, 500, W, H, CARD_W, CARD_H));
    }

    @Test
    public void cardCannotLeaveBottomEdge() {
        // Finger drags far down: y would go to 2096, clamped to 1420 (1920-500).
        assertArrayEquals(new int[]{16, 1420},
                HosOverlayDrag.dragTo(16, 96, 500, 500, 500, 2500, W, H, CARD_W, CARD_H));
    }

    @Test
    public void cardCannotLeaveTopEdge() {
        assertArrayEquals(new int[]{16, 0},
                HosOverlayDrag.dragTo(16, 96, 500, 500, 500, -500, W, H, CARD_W, CARD_H));
    }

    @Test
    public void tapWithinSlopIsNotADrag() {
        assertFalse(HosOverlayDrag.isDrag(500, 500, 508, 496, SLOP));
        assertFalse(HosOverlayDrag.isDrag(500, 500, 516, 500, SLOP));
    }

    @Test
    public void moveBeyondSlopIsADrag() {
        assertTrue(HosOverlayDrag.isDrag(500, 500, 517, 500, SLOP));
        assertTrue(HosOverlayDrag.isDrag(500, 500, 500, 483, SLOP));
    }

    @Test
    public void savedPositionFromBiggerScreenIsPulledInside() {
        // A position saved on a wider/taller screen is clamped to this one.
        assertArrayEquals(new int[]{680, 1420},
                HosOverlayDrag.clampToScreen(1500, 3000, W, H, CARD_W, CARD_H));
        assertArrayEquals(new int[]{0, 0},
                HosOverlayDrag.clampToScreen(-50, -20, W, H, CARD_W, CARD_H));
    }
}
