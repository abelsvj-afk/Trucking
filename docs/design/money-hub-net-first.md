# Money opens on the net - design note (roadmap item 4)

**Status: PROPOSAL, awaiting the owner's design approval. Not implemented. The screen in the studio review is a prototype with
made-up figures, not the app.** Written 2026-11-12 against `main` at `7cfac3d`.

## 1. Current behaviour and evidence

- `/money` (`src/app/(app)/money/page.tsx`, 85 lines) is a list of section rows (Expenses, Fuel purchases, Driver pay,
  Paychecks, Cash advances, Invoices, Truck Fund, Financial summary), then an "Ask Abel" block.
- It already loads the pay summary (`usePaySummary`) and the expenses list, and uses them for two inline figures only:
  "This week: $209.50" on the Expenses row and "Last definite check: $1,034.00" on the Paychecks row (`lib/money-hub.ts`).
- The figure a driver opens Money for, what this pay week nets and when it lands, is one tap deeper on Driver pay or Paychecks.
- The pay summary (`services/api/pay-summary.ts`) already returns everything needed: `paydays[]` with period, payday, expected
  low and high, advances, deductions, net low and high, received; and `totals` with unpaid count and unpaid net.
- Seen at phone width in the test setup. Not verified on the live site.

## 2. Proposed behaviour

**Before:** eight equal rows; two carry a small figure.

**After:** three blocks, top to bottom.
1. **This pay week.** The payday group whose period contains today (viewer's zone). Shows: net, then the arithmetic under it
   ("$1,034.00 expected - $400.00 advances - $0.00 deductions"), the period, and the payday. Tapping it opens Paychecks.
2. **Recent pay weeks.** Up to six payday groups as bars, newest on the right, the current one in gold. Each bar is labelled
   with its payday in words and its amount for screen readers. Tapping opens Paychecks.
3. **The sections,** as compact rows with their current figure on the right where one exists today (expenses this week, last
   definite check). No new figures are invented for rows that have none.

**Honesty rules (these are requirements, not styling):**
- If the expected pay is a range (low differs from high), the net is shown as a range, "about $580.00 to $634.00". Never one
  number chosen from a range.
- If the pay summary is marked partial (advances failed to load), the block says so and shows no net. This is the existing
  rule from the pay-summary fix (task 19); the hub must obey it too.
- If there are no pay terms, the block is the existing "Add pay terms" prompt. If no group contains today, it says
  "No finished loads in this pay week yet" and shows the active load's projected pay if the summary has one.
- The word "expected" or "projected" stays on screen. The settlement is the final number.
- The figure must be produced by the same builder Home and Abel use, so the three can never disagree.

## 3. Affected screens and components

- Changed: `money/page.tsx`, `lib/money-hub.ts` (adds a pure function that picks the current payday group and the bar series).
- New: one presentational component for the block and one for the bar strip.
- Unchanged: `/api/v1/pay-summary`, the pay-summary builder, Driver pay, Paychecks, Home's pay card, Abel's pay tools.
- Not touched: pay terms, advances logic, Business Credit.

## 4. Architecture implications

- Presentation only. No schema, no API contract, no migration. No business logic in the page: selection and series building
  live in `lib/money-hub.ts` as pure functions.
- `docs/design/ui-ux.md` (Money hub) and `docs/money-and-revenue.md` (which figure is "projected" versus "received") must be
  updated in the same change.
- "Today" is the viewer's calendar day (`zonedDate(now, viewerTimeZone())`), as the hub already does for expenses. No UTC.
- Depends on the formatting decision (item 3): this block should use the shared money and calendar-day formatters if they exist
  by then, and `formatCents` / `formatDay` from `lib/pay-projection.ts` if they do not. It must not add a new local formatter.

## 5. Acceptance criteria

1. For the same data and day, the net on Money equals the net on Home's pay card and in Abel's pay answer.
2. A range is shown as a range; a partial summary shows no net and says why; no pay terms shows the setup prompt.
3. The current group is chosen by the viewer's day: at 11:30 PM Eastern on a Saturday it is still that Saturday's pay week.
4. The bar strip shows at most six groups, never a group with zero loads as if it were pay, and every bar has a text label.
5. All eight sections remain reachable from Money in one tap, in today's order.
6. At 390 px: no sideways scroll; the first block and the bar strip fit on the first screen.
7. Negative net (advances exceed expected pay) reads "-$120.00" and is not coloured as good news.

## 6. Tests and regression risks

- Tests: unit tests on the two pure functions (current-group selection across a Saturday-midnight boundary in
  America/New_York; range; partial; no terms; negative net; more than six groups); a render test per state; a shared-builder
  test asserting Money, Home and Abel read the same field; one phone-width screenshot pass.
- Risks: **low to medium.** (a) Showing a wrong net is worse than showing none, hence the honesty rules and the shared-builder
  test. (b) The pay summary is already fetched by the hub, so no new load; if it is slow the block shows the existing loading
  state, never a stale figure. (c) The Home redesign crew owns Home's pay card; this change must not edit it.

## 7. Open questions for the owner

1. Bars: height from the expected amount (recommended) or from what was received?
2. When expected pay is a range, should the big figure be the range (recommended) or the low end labelled "at least"?
3. Should the block also show unpaid finished loads ("2 unpaid, about $825.00"), or leave that on the Paychecks row?
