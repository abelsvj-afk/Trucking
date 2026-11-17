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
