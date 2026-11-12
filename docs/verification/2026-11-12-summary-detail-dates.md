# Verification record - Financial summary detail dates one day early (2026-11-12)

Owner decision 2026-11-12: "Approved - fix first ... two separate, narrowly scoped changes". Branch `fix/summary-detail-day-early`.

- **Defect:** `/money/summary/detail` rendered `delivery_date`, `expense_date` and `service_date` with `formatDate()`. Those are
  calendar days; `formatDate("2026-11-13")` reads UTC midnight and shows "Nov 12, 2026" in America/New_York.
- **Fix:** new `formatCalendarDay()` in `src/lib/time.ts` (a day rendered as written, never through a zone); the three call sites
  on the detail page use it. Fuel's `purchased_at` is an instant and keeps `formatDate()`. No calculation, query or total changed.
- **Reproduction test:** `tests/unit/components/financial-summary-detail-dates.test.tsx` asserts the old function returns
  "Nov 12, 2026" for "2026-11-13" in America/New_York.
- **Regression tests (same file):** the page renders "Delivered Nov 13, 2026", "other - Nov 1, 2026" and "Dec 31, 2026". Run
  against the unfixed page these three FAIL; against the fixed page all 7 pass (both runs done 2026-11-12).
- **Not done here, by the owner's instruction:** `more/business-credit/page.tsx:59` has the same fault on "Next payment due". It
  is recorded for that lane in `docs/work-queue.md`; its file is untouched.
- **Not verified:** the live site. Seen only in tests, not on a phone.
