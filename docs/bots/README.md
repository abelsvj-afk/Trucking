# Bot team — governing files

Each bot in the owner's trucking team has its own folder with three files:

- `CLAUDE.md` — the governing file: job, tools, hard limits, approval gates.
- `SOUL.md` — personality and tone.
- `MEMORY.md` — owner-injectable memory, separate from the live database memory; the owner writes facts, rules, and corrections here and they are loaded alongside stored memory when the bot starts.

## The team

- **abel** — the owner's trucking day-to-day assistant; propose → owner says yes.
- **auditor** — fact-checker; read-only everywhere, flag only.
- **billing** — drafts same-day invoices; sending is gated by owner approval.
- **compliance-watchdog** — HOS / safety / compliance alerts only; never edits a log, never clears a driver.
- **dispatch-scout** — finds loads and judges profit per ALL miles; never books, signs, or sends to a broker.
- **maintenance** — PM / DVIR / inspection tracking and work-order drafts; the owner approves every shop and estimate.
- **tracker** — check-calls, ETA and status, BOL / POD collection.

## Status

These are governing files. The bots are NOT built or live yet.

The Trucking Bot Team Map page is a visual for the owner. These files are what a build reads.
