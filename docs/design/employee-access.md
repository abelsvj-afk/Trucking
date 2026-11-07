# Employee access to Abel (design - NOT built; needs the owner's decisions below)

Owner direction 2026-11-07: Abel should eventually serve his employees too ("when I start giving it to my employees"), learn them,
and recommend loads and home time. Today Abel serves ONE person: the bot is locked to the owner's Telegram chat, and every tool
reads the whole company. Letting a second person in changes who can reach the owner's money, other drivers' data and the
ability to write records. By the project's workflow and the authority rules (`docs/governance.md`,
`docs/ai-authority-matrix.md`) that needs a reviewed design before any code. This is that design.

## 1. Principles
1. **Least privilege, enforced in code.** A driver's access is a short allowlist of tools, each scoped to that driver's own rows by
   the SERVER (a `driver_id` filter inside the tool), never by asking the model to behave.
2. **No new write authority for drivers.** A driver can state their own preferences and send requests; they cannot change loads, pay,
   expenses or anyone else's data. Anything that affects the business is a request the owner approves.
3. **Transparency to the person it learns about.** A driver can ask Abel "what do you know about me?" and sees exactly what is stored
   (preferences, with where each came from) and can ask for one to be corrected. Learned data is for planning around them, not for
   discipline or ranking (fleet-learning principle 3).
4. **Revocable instantly, auditable always.**

## 2. Identity
- New table `driver_channels` (company_id, driver_id, channel 'telegram', external_id (chat id), verified_at, revoked_at). One active
  binding per driver per channel; composite tenant FK to `drivers`.
- Enrollment by one-time code: the owner taps "Invite" on a driver in the app -> a short-lived single-use code is shown (only its hash
  stored). The driver sends the code to the bot; the bot binds that chat id to that driver. A chat id that is not bound is ignored
  exactly as today (silent, fail closed). The owner can revoke a binding in the app; the next message is refused.
- The webhook's secret-token check, per-chat rate limit and update-claim dedupe apply unchanged.

## 3. Roles and the tool allowlist
`owner` (today's behaviour, unchanged) and `driver`. A driver turn builds the tool list from an allowlist; any tool not on it does not exist
for that turn. Proposed driver allowlist, each scoped to the bound driver:
| Tool | Scope |
|---|---|
| `hos_summary` | their own duty logs and clocks |
| `list_loads` / `get_load_paperwork` | loads assigned to them |
| `load_calendar`, `home_time_status`, `delivery_feasibility` | their own loads, preferences and clocks |
| `projected_pay`, `explain_load_pay` | their own pay terms (needs section 5, decision 1) |
| `record_preference` (subject = themselves only) | their own comfort preferences; owner can see and edit them |
| `when_is`, `time_between`, `quick_reference`, `news_digest` | no company data |
| `driver_profile` ("what do you know about me") | themselves only |
Explicitly NOT available: `money_summary`, expenses, fuel, receivables, taxes, other drivers, contacts, documents of others, memories, the game plan,
`fleet_overview`, `recommend_loads` for others, every owner write tool.

## 4. Requests, not edits
Driver-originated changes become `driver_requests` (time off, swap a load, report a problem, "I'm tired - need to stop"), visible to the
owner in the app and in his Telegram, which he approves or declines; Abel tells the driver the outcome. No direct write to loads or pay.

## 5. Decisions the owner must make before any build
1. **Pay terms per driver.** Today pay terms are per company (one set of rates). Employees and lease-ons each have their own terms; this needs
   a driver-scoped pay profile (and the tax-status difference between W2, lease-on and owner-operator).
2. **What a driver may see about their own learned preferences** (recommended: everything stored about them, with its source).
3. **Whether Abel may message a driver first** (home-time nudges, expiring credentials) or only answer - proactive messages to a third party are a
   new authority level (today nothing in the registry messages anyone but the owner).
4. **Retention and consent**: how long driver conversations are kept and what a driver is told at enrollment.
5. **Which channel**: Telegram only (as today) or also an in-app driver view.

## 6. Build order once decided
design review -> `driver_channels` + enrollment + role-aware tool list (read-only own-data tools first) -> own preferences -> `driver_requests`
-> per-driver pay -> proactive nudges (only if decision 3 allows). Each step ships with tests that prove a driver turn CANNOT reach owner data
(the same style as `tests/db/rls-isolation.sql`, but at the tool layer).
