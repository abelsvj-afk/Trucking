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
- **(ii)(D) — the part that is easy to miss:** for EACH of the two periods, the driving immediately before it plus
  the driving immediately after it must not exceed 11 hours, AND the non-rest time immediately before it plus
  immediately after it must not exceed 14 hours. "Immediately before" runs back to the previous qualifying rest
  period (or the last full reset); "immediately after" runs forward to the next qualifying rest period (or now).
  A short break in between does not reset either count. If either check fails for either period, the pair does
  not qualify at all — the clocks stay where the last full reset left them. Without this, a driver who drove
  10h, slept 8h, then drove 5h would be shown hours he does not have (10 + 5 = 15h around the sleeper).
- A full 10 consecutive hours off duty or in the sleeper still resets the 11- and 14-hour clocks, as before.
  It does NOT reset the 60/70-hour limit — only 34+ consecutive hours off duty does that (§ 395.3(c)).
- The 30-minute break is unchanged: any 30 consecutive minutes not driving counts, and both split periods do.

**Source check:** checked against the official eCFR text (49 CFR 395.1(g)(1)(ii)-(iii)) on 2026-11-17. That check
found one real gap — (ii)(D) was not enforced — fixed on this branch with tests in
`tests/unit/lib/split-sleeper.test.ts`.

## Mixed-run ambiguity (open, not settled)

The branch merges consecutive off-duty + sleeper segments into one `RestPeriod` and tests the longest unbroken
sleeper stretch inside it (`src/lib/hos.ts`: the run-merging loop in `findShortClockAnchor`, `longestSleeperMs`).
The regulation allows a period that is "a combination of off-duty time and sleeper berth time", but it does not
define whether a continuous 2h-off + 7h-sleeper run is ONE combination period or TWO periods (2h off + 7h
sleeper = 9h).

Concrete divergence: 2h off + 7h sleeper, then drive, then 2h off. This branch grants the split (one 9h long
period + a 2h partner = 11h total). A strict reading says that is three periods — "not more than two" — so no
split. The branch takes the permissive reading and does not decide the question in code. Open check: how the
carrier's ELD treats a mixed run. Until that is known, the permissive reading stands as the branch's stated
assumption, not as settled law.

## Where it applies

`findShortClockAnchor` in `src/lib/hos.ts` is the one place. It feeds:
- `findWindowStartMs`, so reminders, Abel's hours answers and Smart Path all use it;
- the Home clocks (`lib/hud-clocks.ts`), where the paired second period is excluded from the 14 and a note says
  "Split sleeper in use (8h + 2h)..." or, after the first half, what is still needed to pair it;
- the window end the automatic stop switch uses (`services/fleet/auto-motion.ts`).

Near misses are not counted: 7 hours *off duty* (not sleeper), 6 hours in the sleeper, or a pair under 10 hours total.
These cases are pinned in `tests/unit/lib/split-sleeper.test.ts`.

## Split-sleeper popup (owner 2026-11-17)

When he is getting close to a drive-time limit and a qualifying split pair is still completable, the clocks tell
him on the spot instead of leaving the option in the small note.

- **Trigger:** drive remaining ≤ 2 h OR 14-hour window remaining ≤ 2 h, AND a qualifying offer exists
  (`computeHudClocks` in `src/lib/hud-clocks.ts`, `splitOffer`). Otherwise the quiet split note stands.
- **Projection** (`src/lib/split-sleeper-offer.ts`, pure, `computeSplitOffer`): given the pending first period,
  the minimum second period still needed is worked out (a long first period needs a 2h+ partner; a short first
  period needs a 7h+ sleeper partner; either way ≥ 10h total), taking it starting now is simulated on the
  timeline, and the pair is re-checked through `findShortClockAnchor` — so (ii)(D) is enforced for both periods
  on the projected timeline. A projection that fails (D) offers nothing. The offer returns the rest still
  needed, the window move-to (the end of the FIRST period), and the drive/window left the moment the second
  period ends. Drive kept is what he had not used yet — a partial gain, never a fresh 11.
- **Popup text** (Home clocks, `DutyHud.tsx`): plain words with real times in his zone — what to take, the
  window moves to X, drive left after = Y, that it is a partial gain not a full reset, plus the standing
  "planning only — the ELD's own split calculation is the legal one" line. A first period already taken (e.g.
  last night's partial rest) stays a live candidate until the pair completes or can no longer complete.
- Abel's `hos_summary` tool reports the same offer from the same projection, and its description states the
  reset rule below.

## Manual clock reset (owner 2026-11-17) — DAY-AWARE

The reset is a button HE presses ("Reset clocks", on the Home clocks under the rings) — NEVER automatic, and
there is no tool or job that resets the clocks. One press opens a short confirm sheet; confirming IS the one
press that does it — no multi-step flow, no waiting out a rest period.

- **What it does:** re-derives the short clocks (drive / 14-hour window / 30-minute break) from TODAY's real
  log, from scratch. Driving already done today still counts against the 11; on-duty time already used today
  still counts against the 14; breaks and stops already taken today still count — including a qualifying rest
  period already taken that could still pair for a split (the pending first period survives the reset, and the
  split offer above is projected on the same day-aware anchor). The reset fixes the clocks being wrong (a
  wrong derivation/anchor); it does NOT hand him a fresh day he has not earned.
- **Mechanic:** `POST /api/v1/duty-logs/reset` records a correction event in the existing edit trail
  (`duty_log_edits`, kind `update`, `after.clock_reset_at` = the reset instant; NO migration — see
  `CLOCK_RESET_AT` in `src/services/duty-log-edits.ts`). The original duty rows are never changed. The HOS
  engine reads the latest marker back (`loadHosWindow`) and re-derives the anchor with
  `findShortClockAnchor(segments, { dayStartMs })`, where `dayStartMs` is the start of the reset day in his
  zone (`resetDayStartMsFor` in `src/lib/zoned-day.ts`); the marker applies only while that day is still
  today. A rest period straddling midnight counts in full. With no duty logged that day yet the reset changes
  nothing (the normal derivation stands).
- **Confirm sheet:** shows the day-aware accounting before he presses — hours driven today, on-duty time
  today, breaks taken today (`summarizeDaySoFar` in `src/lib/hos.ts`, computed client-side from the loaded
  rows) — and what the clocks read after the reset. It states plainly: the weekly 60/70 cycle is NOT reset
  (only 34 hours off resets it, § 395.3(c)); the original log stays recorded and the reset shows in its
  history; and if the log ENTRIES themselves are wrong, the reset will not fix the clocks — those entries get
  fixed via the existing duty-log edit path. The reset is visible in `DutyEditHistory` ("Clocks reset by
  hand...") and as a note on the clocks themselves.
- **Stated limitation:** after a reset, (ii)(D) is evaluated on that day's log only — driving from before
  today no longer counts toward the "immediately before" half. That is the reset's stated semantics
  (re-derive from today), not a second reading of the rule.
- **Abel tool decision:** NO new Abel tool. Abel explains the reset (its `hos_summary` description states
  the button is the only reset path) and reports a reset on record; it never resets clocks itself.
