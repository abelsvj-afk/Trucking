# Fleet learning, news, and the questions drivers ask (design)

Owner direction 2026-11-07 (voice): the learning must reach beyond the back-end of the business - to news (trucking, tech,
political), and to HIS PEOPLE: learn each driver so Abel can recommend loads, know when a driver is ready to go home, and
make the money work for the business while keeping the drivers and the owner comfortable. Plus: "think of the millions of
questions drivers could ask - employee, lease-on, owner-operator - and what tools that needs. Keep the list going."
Status key: ✅ already built · 🆕 built with this document · 🗺️ roadmap (with the reason it is not built yet).

## 1. Principles (these bind everything below)
1. **Learning is interpretable and reversible.** No opaque model. Every learned preference carries its plain-words evidence
   ("passed 5 of 6 loads going to the Northeast") and a confidence, and becomes a stored preference ONLY after the owner
   approves it (the normal propose -> yes flow). He can edit or delete any preference.
2. **Comfort is a goal, not a constraint to be squeezed.** Recommendations show money AND comfort AND home-time, side by side,
   with a `balance` dial the owner sets (how much weight money gets vs. comfort). A load that conflicts with a stated preference
   is shown as a conflict with the reason, never silently ranked down or hidden.
3. **Never punitive.** Learned data about a driver is used to recommend and to plan home time. It is not a surveillance or
   discipline score: no ranking of drivers against each other, no "worst driver" views. (Scorecards show a driver's own numbers.)
4. **Abel proposes; people decide.** Recommending a load does not book it. Authority boundaries in `docs/ai-authority-matrix.md` are unchanged.
5. **Computed, not guessed.** Rates, ETAs, days out and lane statistics come from code over his real records; when history is thin
   the tool says so instead of inventing a number.
6. **Free-first, no keys.** Nothing here adds a paid service. News uses free public RSS feeds.

## 2. Preferences store (`person_preferences`, migration 00077)
One row per subject + key: `subject_type` ('owner' | 'driver'), `driver_id` (for drivers; composite tenant FK), `key`,
`value` (jsonb), `source` ('stated' | 'learned'), `confidence` (0-1), `evidence` (plain words), timestamps, soft delete.
Keys are a catalog validated in code (`lib/fleet/preferences.ts`):
- driver: `home_base` {city,state}, `home_time` {every_days, min_days}, `last_home_date`, `preferred_regions`, `avoid_regions`,
  `min_trip_miles`, `max_trip_miles`, `min_cents_per_mile`, `weekly_pay_target_cents`, `weekend_home`, `comfort_notes`.
- owner: `news_interest:<topic>` (weight 0-1), `weekly_revenue_target_cents`, `money_vs_comfort` (0 = all comfort, 1 = all money; default 0.5).
`load_decisions` gains structured columns (origin_state, destination_state, miles, rate_cents, deadhead_miles, driver_id, reason)
so decisions can be LEARNED from, not just read.

## 3. Learning from his people (🆕)
- **Decision learning** (`lib/fleet/learn-decisions.ts`, pure): from taken/passed decisions with features, per feature bucket
  (destination region, trip length, rate-per-mile band, deadhead) acceptance rates; a bucket becomes a CANDIDATE preference
  when n >= 4 and acceptance <= 25% (avoid) or >= 85% (favour). Candidates are shown with evidence and proposed for his yes.
- **Load recommendation** (`lib/fleet/recommend.ts`, pure): each candidate load is scored on money (rate per mile against his
  own lane history and the driver's minimum), comfort (regions, trip length) and home-time (does it get him home when he is due).
  The `money_vs_comfort` dial sets the weights. Output = a verdict, the points per factor, and the reasons.
- **Home time** (`lib/fleet/home-time.ts`, pure): days out from `last_home_date`, due date from `home_time`, and the first
  windows in his booked-load calendar that end near home; flags booked loads that run past the due date.
- **Fleet overview**: every driver's days out / home-time due, current load, week's revenue booked against the owner's weekly target
  and what is still needed - the "make the money work" view.
- Tools: `driver_profile`, `record_preference` (write, always a proposal), `learn_driver_patterns`, `recommend_loads`,
  `home_time_status`, `fleet_overview`, and `record_load_decision` now takes the structured fields.

## 4. News (🆕)
Topics: trucking, regulation (FMCSA/Federal Register already feed the research engine), tech, politics, world/general.
`services/integrations/news-feeds.ts` is a registry of free public RSS feeds per topic read through the existing RSS layer
(per-feed failures reported, never thrown). Political news is shown from SEVERAL outlets across the spectrum with the source on
every headline - headlines and the outlet's own summary only; Abel does not editorialise or take sides. The feed URLs are
UNVERIFIED from the build sandbox (its egress is blocked); a feed that does not answer is named in the reply. `news_digest`
gives each topic a share of the headlines in proportion to his `news_interest` weights (default even; 0 mutes a topic unless he asks for
it directly); he changes the weights with `record_preference` (a proposal, like every preference). Not built: learning those weights
from what he asks for (needs a month of use to mean anything) - he states them for now.

## 5. Employee access (🗺️ - fully designed in `docs/design/employee-access.md`, waiting on the owner's decisions)
Letting drivers talk to Abel themselves means per-driver identity on Telegram, role-based tool access (a driver sees only their own
loads, pay, HOS and preferences - never the company's money or other drivers), instant revocation and audit. That changes who can
reach the owner's data, so it has its own design with five decisions for the owner (pay terms per driver, what a driver sees about
themselves, whether Abel may message a driver first, retention/consent, channel). Today Abel serves the owner, who can ask about any
driver ("recommend loads for Steven", "who needs home time").

## 6. What drivers ask - survey and coverage
Personas: **E** company driver (employee, W2) · **L** lease-on · **O** owner-operator · **F** fleet owner / dispatcher.

| Area | Typical questions | Who | Tool | |
|---|---|---|---|---|
| Pay & settlement | How much will I make this week? When is payday? Why is my settlement short? What is my pay on this load? | E L O | `projected_pay`, `when_is` (pay phrases), Paychecks page, `explain_load_pay`, `weekly_pay_report` | ✅ |
| Rate checks | Is this rate good? What do brokers pay on this lane? What should I counter? | L O F | `evaluate_pay_offer`, `lane_rate_history` | ✅ 🆕 |
| Load choice | Which load should I take? Does it get me home? Is it worth the deadhead? | E L O F | `recommend_loads`, `decision_patterns`, `learn_driver_patterns` | 🆕 |
| Can I make it? | Can I make the 8 AM appointment? When will I get there with my hours? | E L O | `delivery_feasibility` (hours + miles + breaks) | 🆕 |
| Hours of service | How many hours do I have? When can I restart? When is my break due? | E L O | `hos_summary`, clocks in the app | ✅ |
| Home time | When do I get home? How long have I been out? Can I be off Friday? | E L O F | `home_time_status`, `load_calendar` | 🆕 |
| Fleet view | Who needs home time? Who is open? Are we on track for the week? | F | `fleet_overview`, `driver_profile` | 🆕 |
| Money in/out | What did I spend on fuel this month? What is my cost per mile? What do I owe this week? | L O F | `money_summary`, `list_expenses`, `list_fuel_purchases`, `get_cash_calendar` | ✅ |
| Taxes | What should I set aside? IFTA? What can I deduct? | L O | `weekly_pay_report`, `get_ifta_worksheet`, `get_tax_packet`, `quick_reference` (deductions) | ✅ 🆕 |
| Per diem | What is the per diem rate and how many days away was I? | E O | needs a stored yearly rate (not hardcoded) | 🗺️ |
| Maintenance | What is due? What do I do if I break down? | E L O | `maintenance_outlook`, `quick_reference` (breakdown) | ✅ 🆕 |
| Safety & compliance | What do inspectors check? Accident steps? Credentials expiring? Missing log? | E L O | `quick_reference`, `get_credential_watch`, `whats_due` | ✅ 🆕 |
| Detention & paperwork | Am I owed detention? Where is my BOL? | E L O | `stamp_detention`, `get_load_paperwork`, `search_documents` | ✅ |
| Route & road | Weather, fuel stops, road work, states I cross | E L O | `check_route`, Smart Path | ✅ |
| Parking | Where can I park tonight? | E L O | needs a parking data source (none free and reliable) | 🗺️ |
| Weigh stations / state rules | Which stations are open? State-specific rules | E L O | state-rule table is EMPTY until verified data | 🗺️ |
| Time | When is Friday? How many days until...? What happened since Tuesday? What's due? | all | `when_is`, `time_between`, `timeline`, `whats_due`, `load_calendar` | ✅ |
| News | Trucking news, regulations, tech, politics | all | `news_digest`, `list_industry_briefings` | 🆕 ✅ |
| Business growth | Can I add a truck? What is my plan? | O F | `get_game_plan` | ✅ |
| Employee self-service | My next load, my pay, time-off request | E | needs employee access (section 5; design written) | 🗺️ |
| Cash advances / lease deductions | Advance balance, escrow, lease payments | L | a separate feature branch exists (`feature/cash-advances`); not duplicated here | 🗺️ |

`quick_reference` is a small curated, code-reviewed set of general guidance (breakdown, accident, roadside inspection, lost BOL,
detention, deductions overview, HOS rules overview, who-do-I-call checklist). It is general information, not legal or tax advice,
and says so; it never states a figure that changes by year (rates, limits) - those must come from the owner's own stored values.

## 7. Roadmap (kept going)
1. 🆕 Preferences store, decision learning, recommendations, home time, fleet overview (section 3)
2. 🆕 News digest with learned interests (section 4)
3. 🆕 `lane_rate_history`, `delivery_feasibility`, `quick_reference` (section 6)
4. 🗺️ Employee access (section 5) - security design first
5. 🗺️ Per diem tracker (needs the owner's yearly rate as stored data)
6. 🗺️ Parking and weigh-station data (needs a reliable free source; none verified)
7. 🗺️ Driver settlements for employees / lease-ons (pay per driver; overlaps the cash-advances branch)
8. 🗺️ Learning loop on recommendations: log which recommended loads were taken, and learn from the outcomes (needs a month of use first)

## 8. Status at 2026-11-07
BUILT (all gated): 1, 2, 3 above. NOT built, and why: employee access (design done; needs five owner decisions and a security
review), per diem (needs his yearly rate as stored data - the quick reference says so rather than quote a figure), parking and
weigh-station data (no reliable free source verified), per-driver settlements (overlaps the cash-advances branch), learning news
interest from his behaviour (needs usage), and a learning loop that logs which recommended loads were taken (the structured
decision log already feeds it; the automatic hook comes with real use).
