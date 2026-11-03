# Time, timezones, and hours of service

Reliability & Completion Program, Unit B (design:
`docs/reliability-wave1-design-package.md` B.1–B.6; findings F-011,
F-012, F-013, F-015). This document is the contract the code follows;
where code and this document disagree, one of them is a defect.

The app is a **paper-log helper, not an ELD**. Nothing here certifies
anything; the truck's ELD or the official paper logs remain the legal
record, and every HOS surface says so (F-014 — the boundary is not
weakened by anything in this unit).

## The four timezone rules

1. **HOS period computation happens in the carrier's timezone and
   anchor** (`hos_carrier_timezone`, `hos_period_anchor` — see
   below). The viewer's timezone never moves a period boundary.
2. **HOS display happens in the viewer's timezone, with the carrier
   zone and period boundary labeled.** A viewer's local day is never
   presented as if it were the carrier's HOS period.
3. **Financial periods are the viewer's calendar in the viewer's
   timezone** (rule owned by Unit C's C1 — see "Months" below).
4. **Every other timestamp is rendered in the viewer's timezone**
   unless a feature explicitly names another zone.

Shared plumbing lives in `src/lib/time.ts`: `viewerTimeZone()`,
`resolveViewerTimeZone()` (invalid/absent → America/New_York, and the
fallback is *reported*, never silent), `localDateTimeInputValue()`,
and `formatDate`/`formatDateTime` (explicit-zone Intl formatting).

## Months (financial periods)

"2026-08" means the viewer's local calendar month: local midnight on
the 1st through local midnight on the 1st of the next month, in the
viewer's zone. The client already carries the viewer's zone to
`GET /api/v1/financial-summary` (`tz` query parameter) and the
response reports the zone in force (`timeZone` field) — Unit B's B1
plumbing. Converting the summary's shared month definition itself to
viewer-local bounds is **Unit C task C1**, which owns the shared month
helper; until C1 lands, the endpoint's default range is still derived
in UTC and the reported `timeZone` describes the plumbing, not yet
the bounds. That dependency is deliberate in the accepted design and
is stated here so it cannot be mistaken for done.

## Form defaults (F-011)

Every `datetime-local` default or edit pre-fill is composed from
**local** components via `localDateTimeInputValue()` — never from a
UTC string. The defect this replaces: at 8:00 PM Eastern,
`new Date().toISOString().slice(0, 16)` pre-filled *the next day at
00:00 UTC*, and accepting the default silently moved the record. The
audit rule is repo-wide: any `datetime-local` in the app gets the
helper (HOS and pre-trip forms today; a source test enforces that no
UTC-slice initializer returns).

## The HOS window (F-013)

The Hours summary is computed from a dedicated endpoint,
`GET /api/v1/duty-logs/window`, never from the generic list. It
returns every non-deleted duty log from the start of the
carrier-anchored period that begins **(cycle periods + 2) periods
before the current period** (10 periods back for 70/8, 9 for 60/7)
through now, ordered by `started_at` **ascending** — the order the
engines consume. The two extra periods let the engine evaluate a
34-hour restart whose qualifying interval began before the counted
periods, and guarantee no counted period is ever truncated. The
response carries the computed cycle summary and the window actually
used, so the surface states its own basis.

The fetch is capped at 5000 rows as a tripwire: above that the
endpoint fails explicitly (500 `HOS_WINDOW_TOO_LARGE`) rather than
returning a partial window. A summary that cannot be complete is
never shown as if it were — the Hours screen shows an explicit error
with retry instead (the totals guarantee of F-033, applied here).

## The carrier-anchored cycle (F-015)

FMCSA's 60/7 and 70/8 limits run over **consecutive 24-hour periods
that begin at the time of day specified by the motor carrier**. The
cycle total is the on-duty time in the **current period plus the
previous 6 (60/7) or 7 (70/8) periods** — duty segments are summed
from the oldest counted period's start, splitting at that boundary by
construction. A period is the span from one anchor wall time to the
next day's in the carrier zone: boundaries are derived per local
date, so a period spanning a DST transition is 23 or 25 elapsed
hours — the way a paper-log day behaves — not a fixed 24-hour chain.

Two models are explicitly **wrong** and are kept out of the engine
(their answers appear in the tests only, to prove the fixtures
discriminate):

- **Calendar-day bucketing** — anchoring periods to viewer-local
  midnights. (This was the design package's Rev 1 error, retracted in
  Rev 3: FMCSA cycles are rolling consecutive periods anchored to the
  carrier's start time, not calendar days.)
- **Continuous rolling window** — the pre-Unit-B `now − 192h` sum,
  where hours fall out minute-by-minute instead of period-by-period.

Engine: `src/lib/hos-cycle.ts` over `src/lib/hos-periods.ts`; the
14-hour window / 11-hour driving / 30-minute break figures still come
from `src/lib/hos.ts`, fed the same window rows. The Hours screen
labels the cycle line with its basis ("current + previous N carrier
periods (70/8), each starting at {anchor} {carrier timezone}").

### Worked example (the test fixture, hand-verifiable)

Anchor 06:00 America/New_York, cycle 70/8, evaluated Jan 15 2026 at
15:00 EST. History: 10 h on duty in the period that began Jan 7 06:00
EST (Jan 7 20:00 → Jan 8 06:00 EST), then 8 h on duty (06:00–14:00
EST) in each period Jan 8–15.

- **Carrier-anchored (the engine): 3840 min (64 h).** The counted
  periods begin Jan 8 06:00 EST; the Jan-7 period has dropped out
  whole, taking its 10 h with it.
- Rolling 192 h window: **4440 min (74 h)** — the 10 h block starts
  after the window's edge and counts in full.
- Calendar days (Jan 8–15): **4200 min (70 h)** — the 10 h block
  splits at midnight: 4 h on Jan 7 (outside), 6 h on Jan 8 (inside).

The same history under 60/7 counts one fewer period: **3360 min**.

### The 34-hour restart

A qualifying restart — 34+ consecutive hours off duty/sleeper,
observed in the log — moves the counted span to begin with the period
containing the restart's completion; duty before it does not count,
and the surface labels it ("Cycle restarted — 34-hour restart ended
…"). Only the latest qualifying interval governs. When the carrier
has the restart disabled (`hos_restart_enabled = false`), no interval
resets the cycle.

**The ambiguous case is conservative by design.** If the latest
qualifying-length interval *begins with the fetched sequence's first
event*, its true start is unobserved — it may have begun before the
window. The engine does **not** apply it, reports
`restartUnverified`, and the surface says so; the total shown is the
full-window (higher) count. An incomplete log must never make the
helper claim more available time than the record proves. (Documented
interpretation, Unit B build: under status-start events, an
unobservable interval start and excludable in-sequence duty are
mutually exclusive in any single history — if the run starts the
sequence, everything after it is either inside the counted periods or
after the restart's completion period, so "applying" it could not
change the total anyway. The label fires exactly when the unobserved
candidate's completion period is newer than the normal counted
window, which is when a user would otherwise wonder why a visible
long rest didn't reset the cycle.)

## Carrier configuration (B.5)

Per company (migration `00042`, Settings → "Hours of service —
carrier rules"):

| Setting | Column | Meaning |
|---|---|---|
| Cycle | `hos_cycle` | `70/8` or `60/7` |
| Period anchor | `hos_period_anchor` | `HH:MM` wall time each period starts, in the carrier zone |
| Restart | `hos_restart_enabled` | whether the 34-hour restart resets the cycle |
| Carrier timezone | `hos_carrier_timezone` | IANA zone the anchor is read in |

These are **carrier-specified** values. The shipped defaults —
anchor 00:00, 70/8, restart on, America/New_York — are **provisional
configuration** approved by the owner as starting values; the
carrier's actual specified rules were deferred as an owner decision
and are still to be learned and entered. The UI labels the defaults
as provisional wherever they appear; nothing in the app presents them
as verified carrier facts. Reads before migration 00042 is applied
fall back to the same provisional defaults (Postgres 42703), so the
Hours surface works — labeled provisional — in either state; writes
fail explicitly until the migration lands.
