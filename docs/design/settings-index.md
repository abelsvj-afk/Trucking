# Settings as an index - design note (roadmap item 6)

**Status: PROPOSAL, awaiting the owner's design approval. Not implemented. The screen in the studio review is a prototype, not
the app.** Written 2026-11-12 against `main` at `7cfac3d`.

## 1. Current behaviour and evidence

- `/more/settings` is one page (`src/app/(app)/more/settings/page.tsx`, 324 lines) that renders every settings component in a
  single column: `PayTermsSettings`, `HosCarrierSettings`, `BackgroundTrackingSettings`, `TelegramConnectionSettings`,
  `EmailInboxSettings`, Appearance, Home screen, AI authorization with its switches, Account.
- Measured in the test setup at 390 px wide: **about 9,100 px tall** (roughly eleven phone screens).
- It is already grouped by task (owner round 2). `src/lib/settings-groups.ts` defines six groups: My pay, Hours and truck,
  Connections, Appearance and Home, Abel and AI, Account. A jump bar at the top links to `#settings-pay` and the rest.
- Ten links point to `/more/settings` with no anchor (Driver pay x2, Paychecks, Home pay card x2, load pay section, news banner,
  Game Plan, Day log, and the More hub's own row). Nine of them name a specific setting and still drop the driver at the top
  of the long page.
- Not verified on the live site.

## 2. Proposed behaviour

**Before:** one page, six headed groups, a jump bar, about eleven screens.

**After:**
- `/more/settings` becomes an **index**: six rows, one per existing group, each showing what is set now, for example
  "My pay - $0.55 per mile, all miles - weekly, Friday" or "Abel and AI - 12 of 14 on". Target: two phone screens or less.
- Each row opens that group on its own page: `/more/settings/pay`, `/hours`, `/connections`, `/look`, `/ai`, `/account`. The
  page holds exactly the components that group holds today, unchanged.
- Links from elsewhere go straight to the right page (Driver pay's "Set which miles are paid" opens `/more/settings/pay`).
- The old anchors keep working: `/more/settings#settings-pay` forwards to `/more/settings/pay`.
- A group whose values fail to load shows its row without a summary and still opens. A summary is never guessed.

The studio prototype showed seven rows and a search box. This note corrects that to the **six groups that exist**; search is
**not** proposed for the first version (open question 2).

## 3. Affected screens and components

- Changed: `more/settings/page.tsx` (becomes the index), `lib/settings-groups.ts` (adds each group's path and summary builder),
  the ten linking call sites, `lib/setup-checklist.ts` targets.
- New: six thin route pages that each mount existing components.
- Unchanged: every settings component, every API route, every stored value, the AI switches' behaviour and their audit trail.
- Not touched: pay-terms logic, signing configuration, Business Credit.

## 4. Architecture implications

- Routing and layout only. No schema, no API contract, no migration.
- `docs/design/ui-ux.md` lists settings as one screen under More; it must be updated in the same change to describe the index
  and the six pages.
- The row summaries read values the page already fetches. If a summary needs a value no existing endpoint returns, that row
  ships without a summary rather than adding an endpoint in this change.
- AI governance: the global AI switch and the per-capability switches move to `/more/settings/ai` together and stay exactly as
  they are; the index row may show their state but must not offer a way to change it.

## 5. Acceptance criteria

1. At 390 px the index is 1,700 px tall or less and shows six rows.
2. Every setting reachable today is reachable in two taps from the index, with the same label and behaviour.
3. Each of the nine setting-specific links lands on the page that contains the setting it names.
4. `/more/settings#settings-<group>` for all six groups lands on the matching page.
5. Each row's summary equals the stored value; when the value is missing or fails to load, the row shows no summary.
6. No settings component file changes its behaviour (diff limited to imports and wrappers).
7. Nothing scrolls sideways at 390 px on the index or any of the six pages.

## 6. Tests and regression risks

- Tests: a route test per page; a test that the six groups in `settings-groups.ts` each have a page and that the index renders
  exactly those; a redirect test for the six old anchors; a summary test per row including the missing-value case; link tests
  for the linking call sites; one phone-width screenshot pass in the test setup.
- Risks: **low.** (a) A setting stranded on no page: covered by the "exactly those" test. (b) Saved bookmarks to an anchor:
  covered by the redirects. (c) Hash redirects run in the browser, so a first paint of the index may flash before forwarding:
  acceptable, noted. (d) The setup checklist and Abel's messages name "Settings"; wording stays valid.

## 7. Open questions for the owner

1. Row order: keep today's order (pay, hours, connections, appearance, Abel, account)?
2. Search: leave out of version one (recommended), or include?
3. "Appearance and Home" holds two unrelated things. Keep as one page (recommended for now), or split?
