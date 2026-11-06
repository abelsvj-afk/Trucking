// Plain-language explainers for the four HOS clocks (Block B, owner 2026-11-05):
// written for a NEW driver, jargon translated on sight. Each says what the clock
// is, what happens at zero, and what resets it. Static text - no number here is
// computed; the live numbers come from the single HOS read. Paper-log helper,
// not an ELD, and the rules summarized here are the common federal ones: his
// carrier's own rules and the ELD govern.

import type { ClockKey } from "./hud-clocks";

export interface ClockExplainer {
  title: string;
  /** What the clock is. */
  what: string;
  /** What happens when it reaches zero. */
  atZero: string;
  /** What resets it (or gives hours back). */
  resets: string;
  /** Anything a new driver gets wrong. */
  watchOut: string | null;
}

export function clockExplainer(key: ClockKey, cycleLabel: string | null = null): ClockExplainer {
  switch (key) {
    case "drive":
      return {
        title: "Drive clock — 11 hours",
        what: "The most hours you may spend actually driving between rests. Only time with the truck in a driving status counts — loading, fueling, inspections and waiting do not use it.",
        atZero: "You can't drive any more. You have to stop safely and take 10 straight hours off before you drive again.",
        resets: "10 straight hours off duty (off duty or sleeper berth) fills it back up to 11.",
        watchOut: "It is a fixed pool, not a timer on the clock: short breaks do not refill it.",
      };
    case "window":
      return {
        title: "14-hour window",
        what: "Your working day has a fixed length. The 14 hours start when you go on duty after 10 hours off, and then the clock runs on ANY duty time — driving, loading, waiting, even a long lunch. The window never pauses.",
        atZero: "You can't drive any more, even if you still have driving hours left. Park and take 10 straight hours off.",
        resets: "10 straight hours off duty starts a brand-new 14-hour window the next time you go on duty.",
        watchOut: "Sitting at a shipper for hours uses your window without using your driving hours. That is how drivers run out of day.",
      };
    case "break":
      return {
        title: "30-minute break",
        what: "After 8 hours of DRIVING you need a 30-minute break. The clock counts driving time only.",
        atZero: "You can't keep driving. Stop and take 30 straight minutes not driving before you drive again.",
        resets: "30 straight minutes not driving — off duty, sleeper berth, or on duty not driving all count — resets it to 8 hours.",
        watchOut: "A break doesn't pause your 14-hour window; the window keeps running while you rest.",
      };
    case "cycle": {
      const name = cycleLabel ?? "70/8";
      const [hours, days] = name.split("/");
      return {
        title: `${hours ?? "70"}-hour / ${days ?? "8"}-day cycle`,
        what: `A cap on your TOTAL on-duty hours (driving plus all other work) over the last ${days ?? "8"} days — about ${hours ?? "70"} hours.`,
        atZero: "You can't drive until you have hours again. You get hours back as old days fall off the back of the window (your recap shows which day drops off next), or all at once with a restart.",
        resets: "34 straight hours off duty zeroes the cycle — that is the restart. Without one, hours return day by day as old days drop off.",
        watchOut: "Hours you worked more than the window's length ago no longer count; the number goes up by itself each morning as the oldest day falls off.",
      };
    }
  }
}
