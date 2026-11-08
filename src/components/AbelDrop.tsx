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

import { useCallback, useEffect, useRef, useState } from "react";
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

export default function AbelDrop() {
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

  // --- Pupils: springs toward the last tap point / scroll direction.
  const pupilTargetX = useMotionValue(0);
  const pupilTargetY = useMotionValue(0);
  const pupilX = useSpring(pupilTargetX, { stiffness: 170, damping: 19 });
  const pupilY = useSpring(pupilTargetY, { stiffness: 170, damping: 19 });

  // --- Satellite: lags the body on a softer spring; its velocity drives
  // the squash/stretch of the whole goo body (capped at 1.18x).
  const satTargetX = useMotionValue(0);
  const satTargetY = useMotionValue(0);
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

  const schedule = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
    return id;
  }, []);

  // Idle sleep (45s without interaction) + wake on any interaction.
  useEffect(() => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setSleeping(true), IDLE_SLEEP_MS);
    };
    const wake = () => {
      setSleeping(false);
      arm();
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
  }, []);

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
      const radius = 6 + Math.random() * 8;
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
  // cleanups above handle their own; this covers `schedule()` users).
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
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

  return (
    <div
      data-testid="abel-drop-root"
      data-motion={reduceMotion ? "static" : "animated"}
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 60,
      }}
    >
      <div
        data-testid="abel-drop-dock"
        data-side={side}
        style={{
          position: "absolute",
          bottom: "calc(76px + env(safe-area-inset-bottom, 0px))",
          ...(side === "right" ? { right: "12px" } : { left: "12px" }),
          visibility: focusHidden ? "hidden" : "visible",
        }}
      >
        <motion.div
          data-testid="abel-drop-bob"
          animate={
            reduceMotion || sleeping ? { y: 0 } : { y: [0, -3, 0] }
          }
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 3, repeat: Infinity, ease: "easeInOut" }
          }
        >
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
      </div>
    </div>
  );
}
