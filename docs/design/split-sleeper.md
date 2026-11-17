# Split sleeper berth

Status: owner request 2026-11-17 ("research federal split sleeper birth rules and add it... I need it rn"; he uses it
with his carrier's ELD). Branch `feat/split-sleeper`. Paper-log helper, not an ELD: the carrier's ELD split calculation
is the legal record.

## The rule as implemented (property-carrying drivers, 49 CFR 395.1(g)(1)(ii), 2020 amendment)

- One period of at least **7 consecutive hours in the sleeper berth**.
- A separate period of at least **2 consecutive hours** off duty, in the sleeper berth, or a combination.
- Together they total at least **10 hours** (7/3, 8/2, 7.5/2.5 ...). The two may come in **either order**.
- When paired, **neither period counts against the 14-hour window**, and the 11- and 14-hour limits are figured from
  **the end of the first** of the two periods. Pairs chain: the second period of one pair can be the first of the next.
- A full 10 consecutive hours off duty or in the sleeper still resets everything, as before.
- The 30-minute break is unchanged: any 30 consecutive minutes not driving counts, and both split periods do.

**Source check:** written from the rule as published in the 2020 FMCSA final rule. This environment's network blocks
ecfr.gov and fmcsa.dot.gov, and allowing them was declined, so it has **not** been re-checked against the official
eCFR text here. It should be checked against https://www.ecfr.gov (49 CFR 395.1(g)) by someone with access (King).

## Where it applies

`findShortClockAnchor` in `src/lib/hos.ts` is the one place. It feeds:
- `findWindowStartMs`, so reminders, Abel's hours answers and Smart Path all use it;
- the Home clocks (`lib/hud-clocks.ts`), where the paired second period is excluded from the 14 and a note says
  "Split sleeper in use (8h + 2h)..." or, after the first half, what is still needed to pair it;
- the window end the automatic stop switch uses (`services/fleet/auto-motion.ts`).

Near misses are not counted: 7 hours *off duty* (not sleeper), 6 hours in the sleeper, or a pair under 10 hours total.
These cases are pinned in `tests/unit/lib/split-sleeper.test.ts`.
