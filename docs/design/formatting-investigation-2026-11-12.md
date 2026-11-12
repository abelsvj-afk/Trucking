# Money and date formatting - investigation (2026-11-12)

**Status: INVESTIGATION ONLY. Nothing here is implemented. No code was changed to produce it.**
Owner order 2026-11-12: "Investigate item 3 (shared money/date formatter) before proposing implementation. Document all existing
formatting paths, timezone behavior, America/New_York financial-date requirements, and potential regressions."
Measured on `main` at `7cfac3d`. Counts come from `grep` over `src/` (test files excluded); they are counts of text matches, not
a proof that every match is a formatter.

## 1. Money: every path that turns cents into text

79 matches of a cents-to-dollars expression in 52 files. 33 of them are named helper functions. They fall into four behaviours:

| Behaviour | Output for 123456 / -56894 cents | Where (named helpers) |
|---|---|---|
| A. `toFixed(2)`, no separators, sign after `$` | `$1234.56` / `$-568.94` | Pages: Home (`page.tsx:42`), load detail, Smart Path, fuel form, summary detail, Business Credit. Components: `ActiveLoadCard`. Lib: `detention`, `business-snapshot`, `smart-path-map-stops`, `lane-stats`, `fleet/learn-decisions`, `fleet/recommend`. Abel: `tool-helpers`, `tools`, `pay-tools`, `pay-truth`, `route-check-tool`, `telegram/context`, `business-credit/watch`. |
| B. `toLocaleString`, separators, sign after `$` | `$1,234.56` / `$-568.94` | `lib/pay-projection.formatCents` (exported; used by Money hub, Driver pay, Paychecks, advances), invoices page, `fleet/preferences`, Abel `timeline`, `fleet-tools`, `email/ingest`. |
| C. `toFixed(2)`, no separators, sign before `$` | `$1234.56` / `-$568.94` | `lib/truck-fund.formatDollars` (exported; also used by Game Plan and Abel `tools-game`), Financial summary page (since UI pass 2). |
| D. `toLocaleString`, separators, sign before `$` | `$1,234.56` / `-$568.94` | `components/LoadEconomicsSection` only. |

Plus `PayTermsSettings.dollarsFromCents`, which returns a bare number for an input field (not display text; must stay as is).

**What this means on screen today**
- The same amount can read `$2000.00` on a load's page and `$2,000.00` on Driver pay. Evidence is from the code (load detail
  uses behaviour A, Driver pay uses B); the pair was not compared on screen.
- Any negative figure rendered through A or B reads `$-568.94`. Reproduced in isolation: `"$" + (-56894/100).toFixed(2)` gives
  `$-568.94`. Where a negative can actually reach the screen was only confirmed on Financial summary (operating result), which is
  already fixed. Other pages were **not** checked for reachable negatives.
- Abel (Telegram and in-app) mostly speaks behaviour A, so Abel says `$1034.00` where the Paychecks page says `$1,034.00`.

## 2. Dates and times: every path

| Mechanism | Uses / files | Notes |
|---|---|---|
| Shared `lib/time.ts` (`formatDate`, `formatDateTime`, `formatSinceTime`, `viewerTimeZone`) | the intended shared path | Renders an **instant** in the viewer's zone. |
| Shared `lib/eastern-date.ts` (`todayEastern`, `startOfTodayEasternIso`) | server-side "today" | Fixed to America/New_York. |
| Shared `lib/zoned-day.ts`, `services/financial-summary/filter.ts` | day bounds in a zone | Used by HOS and the financial summary. |
| `lib/pay-projection.formatDay`, `lib/temporal.formatLong`, `lib/payday-text` | calendar-day text | Formats a `YYYY-MM-DD` day as written (no shifting). |
| Page-local helpers | `summary/page.tsx formatRangeDay`, `truck-fund/page.tsx formatPeriodDay`, `inbox/page.tsx when`, `loads/[id] formatStampTime`, `TodaysLogStrip formatTime` | Two of these I added this week; they duplicate `formatDay`. |
| Direct calls | `toLocaleDateString` 36 uses / 28 files; `toLocaleTimeString` 8 / 7; `Intl.DateTimeFormat` 37 / 24 | Not individually reviewed. |
| Literal `"America/New_York"` | 100 uses / 58 files | The owner's zone is written out in 58 files rather than read from one place. |
| `toISOString().slice(0, 10)` | 26 uses / 21 files | See section 3. |

## 3. Time-zone behaviour: what is safe, what is not

**The rule (owner's standing rule, `docs/time-and-hos.md`):** no UTC in anything user-facing; "today", week and month boundaries are
the viewer's, and the owner's zone is America/New_York. For money this means a load delivered at 9 PM Eastern on Saturday belongs
to Saturday's pay week, and an expense dated Nov 30 belongs to November, whatever the server clock says. No server time zone is
set in `fly.toml` or the `Dockerfile`, so server code that formats without naming a zone runs in the machine's zone (not verified
on production; normally UTC).

**Safe: calendar-day arithmetic.** Most of the 26 `toISOString().slice(0, 10)` uses add days to a `YYYY-MM-DD` string by going
through UTC noon or UTC midnight and back (`pay-projection.addDays`, `truck-fund.addDays`, `maintenance-schedule.addDays`,
`invoices` page `addDays`, `obligations`, `truck-fund` route `dayAfter`, `zoned-day`, `roadside-packet`, `temporal`). No clock time
is involved, so no zone can shift them. These are correct and duplicated about ten times.

**Confirmed defects (reproduced in isolation, not yet seen on screen or in production):**
1. **A calendar date shown one day early.** `formatDate("2026-11-13")` with zone America/New_York returns "Nov 12, 2026": a
   date-only string parses as UTC midnight, which is the evening before in any US zone. Call sites that pass date-only columns:
   `money/summary/detail/page.tsx` lines 52, 57, 73 (delivery date, expense date, service date) and
   `more/business-credit/page.tsx` line 59 (next payment due). **A due date and a delivery date shown one day early is a
   financial-accuracy bug.** Business Credit is another lane's page; it is listed, not touched.
2. **Abel's weekly pay report can pick the wrong week on Sunday evening.** `services/bot/pay-report.mondayOf(new Date())` takes the
   Monday of the **UTC** week. At 8:30 PM Eastern on Sunday Nov 15 it returns Monday Nov 16, a week that has not started for the
   driver; the Eastern answer is Nov 9. Called from `pay-tools.ts:546`. Window: Sunday 7 PM (8 PM in summer) to midnight Eastern.
   The file's own comment says the UTC key is deliberate for a stable key; it is still used as the reporting week.

**Candidates, not reviewed one by one:**
- Rolling "last N days" filters in Abel (`bot/store.ts:488`, `bot/tools.ts:150`, `bot/tools-read.ts:84, 417`) cut at the UTC day.
  Effect: a window that is up to five hours off at its far edge. Low impact; listed for completeness.
- `services/bot/summaries.weekStartOf` keys conversation summaries by UTC Monday. Internal key, not shown to the driver.
- `lib/fleet-display.ts:71`, `lib/reminders.ts:84`, `lib/detention.ts:130`, `services/fleet/paper-logs.ts:67`,
  `services/game/checkpoint.ts:326` call `toLocale*` with no zone on the same line. Each may set the zone on a following line or
  be formatting a pinned UTC-noon day; **not checked**.

## 4. What a shared formatter would have to guarantee

- **Money:** one function, cents in, text out. Minus sign before the dollar sign. One decision on thousands separators (see
  open question 1). A separate, clearly named function for input-field values. No rounding change: every existing helper already
  rounds to two decimals from integer cents.
- **Calendar days** (`YYYY-MM-DD` columns: delivery, pickup, expense, advance, invoice, due dates): formatted as written, never
  passed through a zone. One function, with weekday and year as options.
- **Instants** (timestamps): keep `lib/time.ts` as the single path, zone always explicit or the viewer's.
- **"Today", week and month bounds:** one module that takes the zone; `todayEastern` stays as the server default.
- **The type system should make defect 1 impossible:** the calendar-day function accepts only a day string, the instant function
  rejects one.

## 5. Regression risks if this is implemented

| Risk | Evidence | Mitigation |
|---|---|---|
| Tests pin exact money strings. | 57 test files contain dollar strings; 19 matches of the no-separator form (`$1234.56`), 24 of the separator form. | Choose the format first; update the pinned strings in the same change; never loosen a test to a regex. |
| Abel's wording changes. | Abel's helpers are behaviour A. Transcript regression tests pin replies. | Treat Abel as a second step, after the app pages, with its transcript tests re-pinned deliberately. |
| A formatter swap hides a calculation change. | 52 files touched. | Mechanical change only, one helper family per commit, no arithmetic in the diff; reviewer greps for `/ 100`. |
| Fixing defect 2 changes which week Abel reports. | By design. | Its own change with a Sunday-evening test in America/New_York, not folded into the formatter work. |
| Other lanes' files (Business Credit, day-log editor, Home redesign). | Listed above. | Leave their files for their owners, or get their agreement first. |

## 6. Open questions for the owner

1. **Thousands separators:** `$1,034.00` everywhere (recommended: it matches Paychecks and a settlement sheet), or none?
2. **Scope:** app pages first and Abel second (recommended), or both at once?
3. **Defects 1 and 2:** fix them ahead of the formatter work as two small changes (recommended: they are accuracy bugs), or
   together with it?
4. **Other lanes:** may the shared formatter replace helpers inside Business Credit and the Home redesign files, or do those
   lanes adopt it themselves?

## 7. What was and was not verified

- Verified by reading code and by running the three expressions in section 1 and 3 in isolation.
- **Not** verified: any of this on the live site; whether a negative figure can reach each behaviour-A page; the five unreviewed
  `toLocale*` call sites; the remaining direct `Intl` and `toLocale*` uses.
