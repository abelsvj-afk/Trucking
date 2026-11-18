# Monthly income and a goal to hit before going home

Status: owner request 2026-11-17. Branch `feat/monthly-income-goal`.

Owner: "I need to see my projected monthly income based off of added and confirmed loads... I have a target amount that I
want to make for the month before I go home... after this load, I'll have enough, and then I can start worrying about
getting them to get me back to Florida... Or even in future tense for my drivers when I hire."

## What it shows (Money → This month, and by asking Abel)

- **Projected pay for the month:** every booked (confirmed) and finished (completed) load whose delivery date falls in
  the month, priced by the same projection as Driver pay and Paychecks (`lib/pay-projection.ts`, the terms in force on
  each load's date, or his own figure on the load). A load that can't be priced is listed and says why; it never counts as $0.
- **Earned vs booked:** finished loads, and loads delivered on or before today, are "earned". The rest are "booked ahead".
- **The goal:** his monthly target. The page shows how much is left to reach it, a running total load by load in
  delivery order ("after Trip 1918: $4,210.00"), and **the load that reaches the goal** ("✅ After Trip 1918 you're at
  your goal — time to plan the way home"). If the booked loads don't reach it, it says how much more is needed.
- **Ranges stay ranges:** when the pay terms give a range, the low end decides whether the goal is reached, and both
  ends are shown.
- **Advances and pay deductions** dated in the month are shown underneath for the take-home picture. The goal is
  measured against pay, not after advances: an advance is money he already has.
- Calendar month on his clock (Eastern), by delivery date. No UTC anywhere.

## Goal storage and drivers

Table `monthly_income_goals` (migration 00099): `company_id`, `driver_id` (null = the owner-operator himself, a
driver's id later), `target_cents`. One live goal per (company, driver), and it applies every month until changed.
Setting it again replaces it. Before 00099 is applied, the page shows the projection without a goal and says so.

## Abel

Tool `monthly_income` (read): the same calculation, so Abel answers "how much will I make this month", "am I at my
goal", "how much more before I can go home". Questions like these are also looked up in code before the model answers
(grounded asks).

## Amendment 2026-11-17: the way home

Once the month's booked loads cover his goal, Abel says which load covers it and roughly how far home is from where
that load ends (`services/bot/way-home.ts`): straight-line distance × 1.2 road allowance at 55 mph, plus a 10-hour rest
for each extra 11-hour driving day. It is labeled "rough estimate, not a route". Home is his `home_base` preference
({ city, state }); without it, Abel asks where home is.
- **Abel:** tool `way_home`, looked up in code for "when can I go home", "how far is home", "way home".
- **Morning check-in:** the same line, only while the goal load is upcoming or delivered yesterday or today, so it
  doesn't repeat all month.
