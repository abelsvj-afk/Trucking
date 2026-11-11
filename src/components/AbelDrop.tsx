"use client";

// AbelDrop — the liquid-drop face of Abel, the assistant (Bucket 4 of
// Trucking-Design-Resources-GitHub-2026-11-02.md).
//
// Rig: an SVG goo body (feGaussianBlur + alpha-contrast feColorMatrix)
// whose main circle (r=26) and trailing satellite (r=10, softer spring)
// melt together while moving and reabsorb at rest, driven by Motion
// springs (stiffness 170 / damping 19) with velocity-driven
// squash/stretch capped at 1.18x. The eyes live in a SEPARATE,
// UNFILTERED layer above the goo — the body melts, the eyes don't.
//
// Safety contract (hard requirements, covered by
// tests/unit/components/AbelDrop.test.tsx):
//  1. Non-occluding: the wrapper is position:fixed inset:0 with
//     pointer-events:none; ONLY the drop's own <button> re-enables
//     pointer-events. No scroll containers are created.
//  2. Auto-hide: unmounted from the DOM on /smart-path (the plan map
//     AND Drive Mode both live under that prefix); visually hidden
//     (visibility + pointer-events off) while any form field is
//     focused — visual-only there because focus changes are transient
//     and unmount/remount would restart every spring and timer.
//  3. prefers-reduced-motion: fully static — no bob, no blink, no
//     satellite drift, springs resolve (near-)instantly — but the drop
//     stays visible and tappable.
//  4. Every timer/listener is removed on unmount.
//  5. Dock points sit over the page margin at the left/right edge,
//     above the bottom nav — never centered over content.
//
// D7 restoration (2026-11-10): the rig above shipped on 2026-11-03
// but read as a STATIC button in real use — the owner's words:
// "a little circle with the eyes... it literally doesn't do anything
// I described it to do." Root causes found in this pass:
//  * No entrance moment: the owner's spec calls for the drop to
//    stretch/squash like liquid WHEN THE APP LOADS; the drop simply
//    appeared.  -> Entrance melt below (satellite starts offset and
//    is reabsorbed while the body springs in with a squash).
//  * Idle amplitudes were sub-perceptual on a phone: a 3px bob and a
//    6-14px same-colour satellite wander inside a 72px disc.
//    -> Bob is 5px; the wander radius is 10-18px so the goo visibly
//    necks and melts at idle.
//  * The two big motions were wired to triggers that never occur:
//    squash peaked during dock travel, but travel needed an
//    undiscoverable double-tap, and the celebrate squash listens for
//    an event nothing in the app fires.  -> Dock travel is now a real
//    spring-driven glide across the screen (velocity stretches the
//    goo), triggered by double-tap OR long-press; a liquid "hop"
//    fires on every route change; waking from sleep plays a stretch.
// The lifecycle is observable via data-life on the root (entering /
// alive / hopping / sleeping / static) so tests — and a human doing a
// visual pass — can tell the drop is alive without guessing.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  motion,
  useAnimationControls,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  useVelocity,
} from "motion/react";

export const ASSISTANT_PATH = "/more/assistant";
const SIDE_STORAGE_KEY = "abel-drop-side";
const IDLE_SLEEP_MS = 45_000;
const DOCK_WIDTH_PX = 72;
const DOCK_MARGIN_PX = 12;
const LONG_PRESS_MS = 550;

type LifeState = "entering" | "alive" | "hopping" | "sleeping";

type DockSide = "left" | "right";

/** Fire Abel's happy-squash reaction from anywhere (future wiring). */
export function abelCelebrate() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("abel:celebrate"));
  }
}

function isFormField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest("input, textarea, select, [contenteditable='true']") !==
    null
  );
}

function inFastWindow(date: Date): boolean {
  const hour = date.getHours();
  return hour >= 20 || hour < 8;
}

const subscribeNever = () => () => {};

// The drop's first render reads the viewport width, the saved dock side,
// the clock and the motion preference - none of which the server knows -
// so server HTML never matched and React threw the whole page away and
// rebuilt it on every load (hydration mismatch). It is decoration that
// only exists in a browser, so it renders there only.
export default function AbelDrop() {
  const inBrowser = useSyncExternalStore(subscribeNever, () => true, () => false);
  return inBrowser ? <AbelDropFace /> : null;
}

function AbelDropFace() {
  const router = useRouter();
  const pathname = usePathname();
  const motionReduced = useReducedMotion();
  // Motion's useReducedMotion caches its first read module-wide, so it
  // is paired with a direct matchMedia subscription — either signal
  // saying "reduce" wins.
  const [mqReduced, setMqReduced] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) =>
      setMqReduced(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const reduceMotion = Boolean(motionReduced || mqReduced);
  const celebrateControls = useAnimationControls();
  const entranceControls = useAnimationControls();
  const hopControls = useAnimationControls();

  const [side, setSide] = useState<DockSide>(() => {
    try {
      const saved =
        typeof window !== "undefined"
          ? window.localStorage.getItem(SIDE_STORAGE_KEY)
          : null;
      return saved === "left" || saved === "right" ? saved : "right";
    } catch {
      return "right";
    }
  });
  const [focusHidden, setFocusHidden] = useState(false);
  const [blinking, setBlinking] = useState(false);
  // Fast-window flavor (Bucket 4): inside the 8pm-8am fast window the
  // drop starts asleep until the first interaction. Trivial to add, so
  // it is implemented; the 45s idle sleep applies at all hours.
  const [sleeping, setSleeping] = useState<boolean>(
    () => typeof window !== "undefined" && inFastWindow(new Date()),
  );

  const lastTapAtRef = useRef(0);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const lastScrollYRef = useRef(0);
  // D7 lifecycle: "entering" during the load melt, "hopping" during a
  // route-change hop; derived display state is computed at render.
  const [phase, setPhase] = useState<"entering" | "ready">("entering");
  const [hopping, setHopping] = useState(false);
  const hoppingRef = useRef(false);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sleepingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const prevPathnameRef = useRef(pathname);
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window !== "undefined" ? window.innerWidth : 0,
  );

  // --- Pupils: springs toward the last tap point / scroll direction.
  const pupilTargetX = useMotionValue(0);
  const pupilTargetY = useMotionValue(0);
  const pupilX = useSpring(pupilTargetX, { stiffness: 170, damping: 19 });
  const pupilY = useSpring(pupilTargetY, { stiffness: 170, damping: 19 });

  // --- Satellite: lags the body on a softer spring; its velocity drives
  // the squash/stretch of the whole goo body (capped at 1.18x).
  // D7: it starts offset (unless reduced motion) so the entrance melt
  // can reabsorb it into the body on load.
  const satTargetX = useMotionValue(reduceMotion ? 0 : -22);
  const satTargetY = useMotionValue(reduceMotion ? 0 : -16);
  const satSpring = reduceMotion
    ? { stiffness: 1000, damping: 100 }
    : { stiffness: 60, damping: 14 };
  const satX = useSpring(satTargetX, satSpring);
  const satY = useSpring(satTargetY, satSpring);
  const satVelX = useVelocity(satX);
  const satVelY = useVelocity(satY);
  const stretchX = useTransform(satVelX, [-500, 0, 500], [1.15, 1, 1.15]);
  const stretchY = useTransform(satVelY, [-500, 0, 500], [1.15, 1, 1.15]);
  const squashScaleX = useTransform([stretchX, stretchY], ([sx, sy]: number[]) => {
    const x = sx ?? 1;
    const y = sy ?? 1;
    return Math.min(1.18, Math.max(0.85, x / Math.sqrt(y)));
  });
  const squashScaleY = useTransform([stretchX, stretchY], ([sx, sy]: number[]) => {
    const x = sx ?? 1;
    const y = sy ?? 1;
    return Math.min(1.18, Math.max(0.85, y / Math.sqrt(x)));
  });

  // --- Dock travel (D7): the dock is anchored at the left margin and
  // the whole drop GLIDES to its side on a spring; travel velocity
  // stretches the goo along the direction of travel (same 1.18 cap).
  // Before the viewport has been measured (first paint) the dock sits
  // at its side via the plain left/right style instead, so there is
  // never a visible jump or a wrong-side flash.
  const travelTargetX =
    viewportWidth > 0 && side === "right"
      ? Math.max(0, viewportWidth - DOCK_MARGIN_PX * 2 - DOCK_WIDTH_PX)
      : 0;
  const dockX = useSpring(travelTargetX, {
    stiffness: 120,
    damping: 20,
    mass: 0.9,
  });
  useEffect(() => {
    dockX.set(travelTargetX);
  }, [dockX, travelTargetX]);
  const travelVelX = useVelocity(dockX);
  const travelScaleX = useTransform(
    travelVelX,
    [-900, 0, 900],
    [1.18, 1, 1.18],
  );
  const travelScaleY = useTransform(travelScaleX, (sx) =>
    Math.min(1.18, Math.max(0.85, 1 / Math.sqrt(sx))),
  );

  // Track the viewport width so the right dock stays at the margin.
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
    return id;
  }, []);

  // Entrance melt (D7): on load the body springs in small and
  // overshoots with a liquid squash while the offset satellite is
  // reabsorbed; two quick blinks right after say the eyes are alive.
  // Reduced motion: no melt at all — the drop is simply there (its
  // life state is "static", derived from reduceMotion at render, so
  // this branch only needs to settle the satellite).
  useEffect(() => {
    if (reduceMotion) {
      satTargetX.set(0);
      satTargetY.set(0);
      return;
    }
    let cancelled = false;
    const reabsorb = setTimeout(() => {
      satTargetX.set(0);
      satTargetY.set(0);
    }, 120);
    void entranceControls
      .start({
        scale: [0.35, 1.14, 0.93, 1.03, 1],
        scaleY: [0.5, 0.88, 1.1, 0.97, 1],
        opacity: [0, 1, 1, 1, 1],
        transition: { duration: 0.85, ease: "easeOut" },
      })
      .then(() => {
        if (!cancelled) setPhase("ready");
      });
    const welcome = setTimeout(() => {
      if (cancelled) return;
      setBlinking(true);
      setTimeout(() => {
        if (cancelled) return;
        setBlinking(false);
        setTimeout(() => {
          if (cancelled) return;
          setBlinking(true);
          setTimeout(() => {
            if (!cancelled) setBlinking(false);
          }, 110);
        }, 160);
      }, 110);
    }, 950);
    return () => {
      cancelled = true;
      clearTimeout(reabsorb);
      clearTimeout(welcome);
    };
    // Runs once on mount; controls/targets are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Route-change hop (D7): using the app makes the drop hop — squash,
  // stretch, settle — so its motion is tied to the app moving, not
  // only to idle drift. The hop is triggered from an animation-frame
  // callback so the state flip never lands synchronously inside the
  // effect body. Skipped for the very first render (the entrance
  // covers it), under reduced motion, and toward /smart-path (the
  // drop unmounts there anyway).
  useEffect(() => {
    if (prevPathnameRef.current === pathname) return;
    prevPathnameRef.current = pathname;
    if (reduceMotion || pathname?.startsWith("/smart-path")) return;
    let innerRaf = 0;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        hoppingRef.current = true;
        setHopping(true);
        void hopControls
          .start({
            scaleX: [1, 1.16, 0.94, 1],
            scaleY: [1, 0.8, 1.13, 1],
            transition: { duration: 0.45, ease: "easeOut" },
          })
          .then(() => {
            hoppingRef.current = false;
            setHopping(false);
          });
        if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = setTimeout(() => {
          hoppingRef.current = false;
          setHopping(false);
        }, 700);
      });
    });
    return () => {
      cancelAnimationFrame(outerRaf);
      if (innerRaf) cancelAnimationFrame(innerRaf);
    };
  }, [pathname, reduceMotion, hopControls]);

  // Keep the ref mirror of `sleeping` current for the wake handler.
  useEffect(() => {
    sleepingRef.current = sleeping;
  }, [sleeping]);

  // Idle sleep (45s without interaction) + wake on any interaction.
  // D7: waking from an actual sleep plays a small stretch-yawn (via
  // the celebrate controls) so sleep/wake reads as a living thing.
  useEffect(() => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setSleeping(true), IDLE_SLEEP_MS);
    };
    const wake = () => {
      const wasSleeping = sleepingRef.current;
      setSleeping(false);
      arm();
      if (wasSleeping && !reduceMotion) {
        void celebrateControls.start({
          scaleX: [1, 1.13, 0.95, 1],
          scaleY: [1, 0.86, 1.09, 1],
          transition: { duration: 0.45, ease: "easeOut" },
        });
      }
    };
    arm();
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    window.addEventListener("touchstart", wake, { passive: true });
    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      window.removeEventListener("touchstart", wake);
    };
  }, [celebrateControls, reduceMotion]);

  // Blink loop: scaleY to 0.1 for 120ms every randomized 2.8-5.5s.
  // No blinking while asleep (eyes are closed arcs) or reduced-motion.
  useEffect(() => {
    if (reduceMotion || sleeping) return;
    let cancelled = false;
    let inner: ReturnType<typeof setTimeout> | undefined;
    let outer: ReturnType<typeof setTimeout> | undefined;
    const loop = () => {
      outer = setTimeout(
        () => {
          if (cancelled) return;
          setBlinking(true);
          inner = setTimeout(() => {
            if (cancelled) return;
            setBlinking(false);
            loop();
          }, 120);
        },
        2800 + Math.random() * 2700,
      );
    };
    loop();
    return () => {
      cancelled = true;
      if (outer) clearTimeout(outer);
      if (inner) clearTimeout(inner);
    };
  }, [reduceMotion, sleeping]);

  // Satellite drift: small wander targets so the goo necks and melts
  // while "alive"; at rest the target returns to centre and the
  // satellite reabsorbs into the main circle.
  useEffect(() => {
    if (reduceMotion) {
      satTargetX.set(0);
      satTargetY.set(0);
      return;
    }
    const id = setInterval(() => {
      if (sleeping) {
        satTargetX.set(0);
        satTargetY.set(0);
        return;
      }
      const angle = Math.random() * Math.PI * 2;
      // D7: 10-18px (was 6-14) so the goo visibly necks and melts at
      // idle on a phone-sized disc instead of trembling invisibly.
      const radius = 10 + Math.random() * 8;
      satTargetX.set(Math.cos(angle) * radius);
      satTargetY.set(Math.sin(angle) * radius);
    }, 1600);
    return () => clearInterval(id);
  }, [reduceMotion, sleeping, satTargetX, satTargetY]);

  // Pupil look-toward: last tap point (clamped to 3px) and scroll drift.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const el = document.querySelector('[data-testid="abel-drop-button"]');
      const rect = el?.getBoundingClientRect();
      if (!rect) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = event.clientX - cx;
      const dy = event.clientY - cy;
      const len = Math.hypot(dx, dy) || 1;
      // Normalise exactly to the 3px cap in the tap direction.
      pupilTargetX.set((dx / len) * Math.min(3, len));
      pupilTargetY.set((dy / len) * Math.min(3, len));
    };
    const onScroll = () => {
      const y = window.scrollY;
      const dir = Math.sign(y - lastScrollYRef.current);
      lastScrollYRef.current = y;
      if (dir !== 0) {
        pupilTargetY.set(dir * 3);
        schedule(() => pupilTargetY.set(0), 600);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll);
    };
  }, [pupilTargetX, pupilTargetY, schedule]);

  // Focus auto-hide: hidden while any form field holds focus.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      if (isFormField(event.target)) setFocusHidden(true);
    };
    const onFocusOut = () => {
      // Restore unless focus moved straight into another form field
      // (that focusin fires right after and re-hides anyway; checking
      // activeElement keeps the restore flicker-free).
      if (!isFormField(document.activeElement)) setFocusHidden(false);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  // Celebrate reaction: happy squash on the custom event.
  useEffect(() => {
    const onCelebrate = () => {
      setSleeping(false);
      if (reduceMotion) return;
      void celebrateControls.start({
        scaleX: [1, 1.18, 0.9, 1],
        scaleY: [1, 0.84, 1.1, 1],
        transition: { duration: 0.5, ease: "easeOut" },
      });
    };
    window.addEventListener("abel:celebrate", onCelebrate);
    return () => window.removeEventListener("abel:celebrate", onCelebrate);
  }, [celebrateControls, reduceMotion]);

  // Clear any one-shot scheduled timers on unmount (blink/idle/drift
  // cleanups above handle their own; this covers `schedule()` users
  // and the long-press timer).
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      if (safetyTimerRef.current) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
    };
  }, []);

  // Route auto-hide: map + Drive surfaces both live under /smart-path.
  // Unmounted from the DOM entirely — a hard surface exclusion, unlike
  // the transient focus hide.
  if (pathname?.startsWith("/smart-path")) return null;

  const flipSide = () => {
    setSide((prev) => {
      const next = prev === "right" ? "left" : "right";
      try {
        window.localStorage.setItem(SIDE_STORAGE_KEY, next);
      } catch {
        // Non-fatal: the flip still applies for this session.
      }
      return next;
    });
  };

  const handleClick = () => {
    // A completed long-press already flipped the dock; the click that
    // follows the pointer-up must not also navigate.
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const now = Date.now();
    if (now - lastTapAtRef.current < 350) {
      // Double-tap flips the dock instead of navigating twice.
      lastTapAtRef.current = 0;
      flipSide();
      return;
    }
    lastTapAtRef.current = now;
    router.push(ASSISTANT_PATH);
  };

  // Long-press (D7): holding the drop flips the dock — the discoverable
  // alternative to double-tap. The flip itself wakes the drop and the
  // glide across the screen is the liquid travel motion.
  const handlePointerDown = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      suppressClickRef.current = true;
      flipSide();
    }, LONG_PRESS_MS);
  };
  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const life: LifeState | "static" = reduceMotion
    ? "static"
    : phase === "entering"
      ? "entering"
      : sleeping
        ? "sleeping"
        : hopping
          ? "hopping"
          : "alive";

  return (
    <div
      data-testid="abel-drop-root"
      data-motion={reduceMotion ? "static" : "animated"}
      data-life={life}
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 60,
      }}
    >
      <motion.div
        data-testid="abel-drop-dock"
        data-side={side}
        style={{
          position: "absolute",
          bottom: "calc(76px + env(safe-area-inset-bottom, 0px))",
          left: `${DOCK_MARGIN_PX}px`,
          ...(viewportWidth > 0
            ? { x: dockX }
            : side === "right"
              ? { left: "auto", right: `${DOCK_MARGIN_PX}px` }
              : {}),
          visibility: focusHidden ? "hidden" : "visible",
        }}
      >
        <motion.div
          data-testid="abel-drop-bob"
          animate={
            reduceMotion || sleeping ? { y: 0 } : { y: [0, -5, 0] }
          }
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 3, repeat: Infinity, ease: "easeInOut" }
          }
        >
          <motion.div
            style={
              reduceMotion
                ? undefined
                : { scaleX: travelScaleX, scaleY: travelScaleY }
            }
          >
            <motion.div
              animate={entranceControls}
              initial={
                reduceMotion
                  ? false
                  : { scale: 0.35, scaleY: 0.5, opacity: 0 }
              }
            >
              <motion.div animate={hopControls}>
                <motion.div animate={celebrateControls}>
                  <motion.div
                    style={
                      reduceMotion
                        ? undefined
                        : { scaleX: squashScaleX, scaleY: squashScaleY }
                    }
                  >
                    <button
                      type="button"
                      data-testid="abel-drop-button"
                      aria-label="Open Abel, the assistant"
                      onClick={handleClick}
                      onDoubleClick={flipSide}
                      onPointerDown={handlePointerDown}
                      onPointerUp={cancelLongPress}
                      onPointerLeave={cancelLongPress}
                      onContextMenu={(event) => event.preventDefault()}
                style={{
                  pointerEvents: focusHidden ? "none" : "auto",
                  width: "72px",
                  height: "72px",
                  minHeight: "72px",
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  position: "relative",
                  display: "block",
                }}
              >
                {/* Goo body — filtered layer. */}
                <svg
                  width="72"
                  height="72"
                  viewBox="0 0 72 72"
                  aria-hidden="true"
                  style={{ display: "block" }}
                >
                  <defs>
                    <filter id="abel-goo">
                      <feGaussianBlur
                        in="SourceGraphic"
                        stdDeviation="6"
                        result="blur"
                      />
                      <feColorMatrix
                        in="blur"
                        mode="matrix"
                        values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10"
                      />
                    </filter>
                  </defs>
                  <g filter="url(#abel-goo)" fill="#f2b705">
                    <circle cx="36" cy="36" r="26" />
                    <motion.circle
                      cx="36"
                      cy="36"
                      r="10"
                      style={{ x: satX, y: satY }}
                    />
                  </g>
                </svg>
                {/* Eyes — separate, UNFILTERED layer above the goo. */}
                <svg
                  width="72"
                  height="72"
                  viewBox="0 0 72 72"
                  aria-hidden="true"
                  style={{
                    display: "block",
                    position: "absolute",
                    inset: 0,
                  }}
                >
                  <circle cx="28" cy="27" r="6" fill="#ffffff" opacity="0.35" />
                  {sleeping ? (
                    <g
                      stroke="#ffffff"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      fill="none"
                    >
                      <path d="M21 33 Q27 37 33 33" />
                      <path d="M39 33 Q45 37 51 33" />
                    </g>
                  ) : (
                    <motion.g
                      animate={{ scaleY: blinking ? 0.1 : 1 }}
                      transition={{ duration: 0.06 }}
                      style={{
                        transformBox: "fill-box",
                        transformOrigin: "center",
                      }}
                    >
                      <circle cx="27" cy="33" r="5.5" fill="#ffffff" />
                      <circle cx="45" cy="33" r="5.5" fill="#ffffff" />
                      <motion.g style={{ x: pupilX, y: pupilY }}>
                        <circle cx="27" cy="33" r="2.6" fill="#0f172a" />
                        <circle cx="45" cy="33" r="2.6" fill="#0f172a" />
                      </motion.g>
                    </motion.g>
                  )}
                    </svg>
                    </button>
                  </motion.div>
                </motion.div>
              </motion.div>
            </motion.div>
          </motion.div>
        </motion.div>
      </motion.div>
    </div>
  );
}
