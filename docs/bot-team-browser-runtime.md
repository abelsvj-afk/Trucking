# Browser runtime — Dispatch Scout board reading

Owner decision, recorded 2026-11-19: the bots read load boards through a
**separate always-on VM the bots share** (route (b)), a small Fly app
(e.g. `trucking-browser`), NOT a headless browser inside the main Fly
app backend (route (a)). This doc records the decision, the reasoning,
the contract between the main app and the VM, and what is still open.

Status: design only. **The VM does not exist yet.** No live board read
has been performed against it, and the `readBoard` HTTP path in
`src/services/bots/browser-runtime.ts` is unproven against a real
worker. Provisioning the VM is a follow-up that needs the owner's word,
because it is a new recurring bill (see Cost).

Two owner requirements, settled 2026-11-19, are designed in here:
**live watch** (the owner watches Scout's browser live from his phone
and can stop the run and take the browser over) and **24/7 always-on**
(Scout checks boards on a schedule around the clock, on this VM).

## Why route (a) loses

Running a headless browser inside the main Fly app backend ("trucking")
was considered and rejected, for four separate reasons — any one of
them would be enough:

1. **The session would not survive.** The main app's machines
   auto-stop when idle (`auto_stop_machines = 'stop'`). A browser
   profile that holds a logged-in board session cannot live on a
   machine that stops; every cold start would mean a fresh login, and
   repeated logins from fresh sessions are exactly what gets an
   account flagged or locked out.
2. **The machines are too small.** The app runs on 1 GB shared-CPU
   machines. A real Chromium plus the app itself on the same machine
   risks running out of memory, and an out-of-memory crash in the
   browser would take the whole app down with it.
3. **Headless fingerprints trip bot checks.** TruLOS already showed a
   Cloudflare human-check to a browser on 2026-11-19. A headless
   browser inside a server process looks more automated, not less,
   and is more likely to be challenged or blocked.
4. **Long reads do not fit request handlers.** A board read at human
   pace — open the page, wait, read the table — takes seconds to a
   minute. That does not belong inside a webhook or API request
   handler that the rest of the app depends on.

## Route (b): a separate always-on VM

One small Fly app, e.g. `trucking-browser`, that the bots share.
**The 24/7 requirement settles this choice.** Scout runs on a
machine that is on 24/7 — checking boards on a schedule, keeping the
shortlist fresh. The main Fly app backend cannot be that home: its
machines auto-stop when idle, so there is nobody awake to run a
schedule, keep a logged-in session, or answer a watch page at 3 AM.
The separate always-on VM is the only route that meets the
requirement; route (a) is out for this reason alone, on top of the
four reasons above.

- **One always-on machine** — `auto_stop_machines` off, so it never
  sleeps. The browser profile (cookies, logged-in sessions) lives on
  the machine and survives between reads. **The same VM is also the
  home of the scan scheduler** (see "24/7 always-on" below) — one
  bill, one home for both the browser and the schedule, not two VMs.
- **A small Fly volume** attached to the machine, holding the browser
  profile directory. The profile lives on the VM volume, **never in
  the repo** — the repo is public.
- **One job at a time.** The VM serves one board read at a time, at
  human pace (see below). It is a shared utility for the bot team,
  not a per-bot browser: Dispatch Scout is the only bot that searches
  boards, so it is the only caller today.
- **Nothing else runs on it.** No app code, no database, no Telegram
  webhook. If the VM is down, the main app still works — board reads
  just report "not configured" / "error" and the Scout says so
  plainly instead of inventing loads.

## Cost — ESTIMATE

> **Estimate, not a quote.** Fly's prices change and vary by region.
> Confirm the live figures on Fly's pricing page
> (https://fly.io/docs/about/pricing/) before provisioning. All
> figures below are the list prices found on 2026-11-19 for the
> cheapest region, Ashburn (iad), for a machine running all 30 days
> of the month.

| Line | Estimate |
| --- | --- |
| Machine, shared-cpu-1x, 1 GB RAM, always on (iad) | ~$6.70 / month |
| Volume, 3 GB at $0.15 / GB / month (browser profile) | ~$0.45 / month |
| Egress (board pages are small text; a few GB at $0.02 / GB) | ~$0.05 / month |
| **Total** | **~$7–$8 / month** |

Notes on the estimate:

- The absolute smallest Fly machine (shared-cpu-1x, 256 MB) lists at
  ~$2.19 / month, but 256 MB is **too small to run a real Chromium
  browser in practice** — that is why the estimate above prices the
  1 GB machine instead. Do not provision the 256 MB size to save
  $4.50 and then debug out-of-memory crashes.
- A 1 GB volume (~$0.15 / month) would likely hold a profile; 3 GB
  is priced above as headroom for profile growth and a second
  board's session. Either way the volume is the cheapest line.
- Region matters: the same machine costs more outside Ashburn /
  Secaucus (e.g. ~$7.73 in Frankfurt). Keep the VM in iad, where the
  main app already runs.
- **Provisioning needs the owner's word.** This is a new recurring
  bill of roughly $7–$8 a month, every month, for as long as the
  Scout reads boards. Nobody provisions it on a guess.

## HTTP contract — main app to browser VM

The main app (`src/services/bots/browser-runtime.ts`) is the only
client. The VM exposes these endpoints:

```
POST /read
x-bot-browser-secret: <shared secret>
Content-Type: application/json

{ "board": "trulos", "url": "https://trulos.com/load-board", "runId": "run_..." }
```

`runId` is optional: the main app passes the current scan run's id
when one exists, so the VM can tie the browser session to that run
for live watch. A read without a `runId` still works — it is just
not watchable by run.

Response (JSON):

```
{
  "boardSlug": "trulos",
  "status": "ok" | "blocked-cloudflare" | "blocked-login" | "empty" | "error",
  "loads": [ /* raw rows, exactly as read from the board's table */ ],
  "note": "plain-words note about this read"
}
```

Rules of the contract:

- **Raw rows out, normalized loads in the app.** The VM returns the
  board's rows as it read them. `src/services/bots/boards.ts`
  normalizes them into `BoardLoad` — a field the board did not give
  stays null, never guessed.
- **The secret is a shared secret, not a login.** The header
  `x-bot-browser-secret` proves the caller is the main app. It is
  not a board password and it never leaves the server side.
- **One read, one board.** The VM reads the board it was asked for
  and returns. Ranking, fallback, and pacing live in the main app
  (`walkBoards` in `boards.ts`, `HUMAN_PACE` in
  `browser-runtime.ts`), not in the VM.
- **Failures are statuses, not crashes.** A board that blocks, a
  login that expired, an empty table, or a worker error all come
  back as a status with a plain-words note. The main app never
  throws for a failed read — the walker falls through to the next
  board.
- **Timeout: 60 seconds.** A read that takes longer is abandoned by
  the caller (`HUMAN_PACE.readTimeoutMs`), not retried blindly.

```
POST /stop
x-bot-browser-secret: <shared secret>
Content-Type: application/json

{ "runId": "run_..." }
```

Stops the named run on the VM: the browser is parked, no further
board is read in that run, and the run is reported as stopped. The
VM answers `{ "stopped": true, "note": "..." }`, or
`stopped: false` with a plain-words note when there was nothing to
stop (the run already finished) or the stop did not land. The main
app's `stopRun()` never throws — a failed stop is a
`stopped: false` answer, and the owner is told to check the watch
page. The stop call times out after 15 seconds
(`STOP_RUN_TIMEOUT_MS`).

```
GET /watch/:runId
```

The live-watch page for a run (see "Live watch" below). It is a
plain page the owner opens in his phone's browser — no app install,
no login screen. The `:runId` in the URL is the run's unguessable
token (see below); there is no other way to open a watch page.

## Live watch — see Scout's browser, stop it, take it over

Owner requirement, 2026-11-19: the owner must be able to SEE
Scout's cloud browser working — click in from his phone and watch
live what board Scout is on, what load he is reading, what he is
clicking. Like a screen share of the browser session. Plus a way to
STOP the run and TAKE OVER the browser if something looks wrong.

### Final choice: Xvfb + noVNC

The browser VM runs the real browser under **Xvfb** (a virtual
display, no physical screen) and serves that display via **noVNC** —
the VNC protocol in the phone's browser, no VNC app needed. The
owner opens the watch page (`GET /watch/:runId`, built by
`watchUrl(runId)` in `browser-runtime.ts`) and sees the live browser
exactly as Scout sees it: the board, the load, the clicks, in real
time. A STOP button sits on the watch page; tapping it calls
`POST /stop` for that run. Takeover is native: once the owner taps
"Take over" on the watch page, his own mouse and keyboard drive
that same browser session through the VNC stream — Scout's run is
paused while he holds it, and the session (logins, tabs, board
state) is the same one Scout was using, so nothing is lost and
nothing is re-logged-in. When he releases it, the run either
resumes from where it stopped or stays stopped until the next
scheduled scan — the watch page says which, and the run's report
says what happened.

### Why noVNC beats the alternative (CDP screencast)

The other shape considered was streaming screencast frames from
Chrome DevTools Protocol (CDP) over a websocket and drawing them in
a page. noVNC wins for three reasons:

1. **Takeover is free.** VNC is built for remote input — mouse and
   keyboard drive the session with no extra code. A CDP screencast
   is watch-only by default; takeover would mean building a second
   channel (input events back through CDP, focus handling, click
   mapping) and getting it exactly right, or the owner's clicks
   would land on the wrong load.
2. **What the owner sees is the whole truth.** noVNC shows the
   entire desktop: the browser, any dialog, a login prompt, a
   Cloudflare challenge. A CDP screencast shows one tab's frames;
   a challenge page, a popup, or a second tab can be invisible to
   it while Scout is stuck on it.
3. **Nothing custom to maintain.** Xvfb + noVNC is off-the-shelf,
   phone-browser-friendly, and already proven for exactly this job
   (watch a remote browser). A CDP streaming pipeline is custom
   code the team would own forever.

What noVNC loses: it is heavier than a frame stream — a virtual
display plus a VNC server plus the browser on one small VM, which
is another reason the 1 GB machine in the cost estimate is the
floor, not the 256 MB one. Input has a little more latency than a
local browser (a beat behind on a phone connection), and the VNC
stream is a second surface that must be secured (below). Neither
loss matters for watching a load board and stopping a run.

### Watch security — the link is the key

- The `runId` is a **random, unguessable per-run token** (generated
  by the main app when a scan run starts — never sequential, never
  a board name or a date). The watch URL contains it, and it is the
  only credential the watch page needs.
- The link is sent **to the owner only** (his chat / the group he
  is in — never a public channel, never the repo). Anyone with the
  link can watch and take over, so it is treated like a password:
  never forwarded, never screenshotted into a shared place.
- The token is **live only while the run is live, plus a short
  grace after it ends** (enough to look at the final screen). Once
  it expires, the URL opens nothing. A finished run's link does not
  open a live browser later.
- The watch page is served over TLS (Fly's TLS on the VM's public
  address). The STOP button on the page calls `POST /stop` through
  the VM itself — the page holds the run token, not the shared
  secret, and the secret never reaches the phone.
- Takeover pauses Scout: while the owner holds the browser, the
  run does not read, click, or advance. Two drivers, one browser
  is how loads get booked by accident — and the Scout never books
  anything anyway.

### What the owner sees on the watch page

- The live browser, full screen on his phone (pinch to zoom, the
  way any remote desktop works).
- A small bar above it: which board Scout is on, which load he is
  reading, and the run's status (reading / paused / stopped).
- Two buttons: **STOP RUN** (kills the run, parks the browser) and
  **TAKE OVER** (his mouse/keyboard drive the session; Scout
  pauses). Releasing takeover hands the browser back.

## 24/7 always-on — Scout never sleeps

Settled requirement, 2026-11-19: Scout runs on a machine that is
on 24/7 — checking boards on a schedule, keeping the shortlist
fresh. This is what confirms the route (b) choice (see above): the
Fly app backend machines auto-stop when idle and cannot be the
24/7 home.

- **One VM, one bill.** The always-on VM is the same VM as the
  browser VM: the scan scheduler and the browser live on the same
  machine, under the same ~$7–$8/month estimate. No second VM, no
  second bill.
- **The Fly app stays the system of record.** Proposals, the load
  ledger, bot memories, and the group chat all live in the main app
  and Supabase, as in the Phase 0 baseline. The VM reads boards and
  runs the schedule; it does not own the truth. If the VM dies, the
  ledger, the proposals, and the chat are all still there — only
  fresh reads stop until it is back.

### Scan schedule — defaults (owner can change them)

Coded as `SCOUT_SCAN_DEFAULTS` in `browser-runtime.ts`. All times
Eastern (America/New_York) — never UTC.

| Window | Default |
| --- | --- |
| Day, 6 AM–9 PM ET | Re-check the boards every **30 minutes** |
| Night, 9 PM–6 AM ET | Re-check every **60 minutes** |
| Quiet hours, 9 PM–6 AM ET | Scanning continues, but anything the owner would SEE holds until morning unless time-sensitive (below) |

Each scan is one `walkBoards` run: the ranked free boards in order,
human-pace gaps between reads, a per-board report, and a fresh
shortlist only when something changed. A scan that finds nothing
new posts nothing — the group chat is not a log file.

### Heartbeat — silence is a signal

- The VM posts a **heartbeat to the main app every 5 minutes**
  (`heartbeatIntervalMinutes: 5`) — a small signed call that says
  "I am up, the browser is alive, the last scan finished at HH:MM".
- **A missed heartbeat means the app flags the Scout as down in
  the group chat instead of staying silent.** If no heartbeat has
  arrived for 15 minutes (`heartbeatMissedMinutes: 15`), the main
  app posts: Scout has not checked in, the last good scan was at
  HH:MM, and the shortlist may be stale. The owner is never left
  looking at a fresh-looking shortlist from a dead Scout.
- The heartbeat endpoint on the main app is still to be built (see
  Open items) — the interval and the missed-heartbeat rule above
  are the contract it must meet.

### Guardrails around the always-on loop

The loop runs itself, but the standing rules do not loosen because
nobody is watching:

- **Quiet hours, 9 PM–6 AM ET.** Scanning and reading continue
  around the clock — loads do not keep office hours. But anything
  the owner would SEE holds until morning: a new shortlist is
  drafted and kept, not posted to the group, unless it is
  **time-sensitive** — a pickup window closing within a few hours,
  or a load whose window shuts before morning. A time-sensitive
  find wakes the group; a routine refresh waits for 6 AM.
- **Never book, pay, sign, or message a broker without the owner,
  ever.** The always-on loop changes nothing about propose-only.
  The Scout drafts shortlists; the owner decides. There is no
  hour of the night at which a bot books a load on its own.
- **The model-spend cap still gates every model call.** The cap
  from migration 00103 (`bot_spend_ledger`, default **$10/month**)
  applies to every scan's model calls, day and night. When the cap
  is hit, the loop **stops plainly** — it posts that the cap is hit
  and the Scout is paused until the owner raises it or the month
  turns — instead of quietly burning money or silently going dark.
  Cheap model scans, stronger model only to rank the best few,
  exactly as in the baseline plan.
- **One run at a time.** A scan that is still running when the next
  one is due is skipped, not stacked. Two Scouts reading the same
  board at once is how accounts get flagged.
- **Every scan is logged.** Each run lands in the audit log with
  its per-board report (which boards were read, which blocked,
  how many loads were usable) so the owner — and the Auditor —
  can check what the Scout actually did overnight.

## Credentials rule

- **Fly secrets only, never the repo, never chat, never shown.**
  Board logins live as Fly secrets on the browser VM
  (`BOT_BROWSER_URL` and `BOT_BROWSER_SHARED_SECRET` are the main
  app's side of the same arrangement, also Fly secrets). No board
  password, session cookie, or secret value is ever written into
  code, a doc, a test, or a chat message.
- Sign in once, on the VM, at human pace; the session is kept on
  the VM volume. Credentials are never shown to any bot, including
  the Scout — the Scout asks the VM for loads, it never sees the
  login.

## Human-pace policy

The boards are read as a guest reads them, not scraped:

- **Minimum 20 seconds between reads**
  (`HUMAN_PACE.minGapMsBetweenReads`).
- **At most 3 boards per run** (`HUMAN_PACE.maxBoardsPerRun`) — the
  whole free list, no more.
- **No parallel hammering.** One read at a time, one board at a
  time. No concurrent requests to the same board.
- **No scraping.** The VM drives a real browser and reads the
  rendered table, the way a person would. It does not hammer
  endpoints, does not bypass a challenge, and does not pretend to
  be a person — it is a browser session, at human pace.
- **A read that fails is reported, not retried in a loop.** One
  attempt per board per run. If the board blocks, the walker falls
  to the next board and the report says which board blocked.

## Cloudflare handling

TruLOS showed a Cloudflare "Verify you are human" challenge to a
browser on 2026-11-19, so this is a live risk, not a theory:

- The first defence is the setup itself: a real browser, a kept
  session on the VM volume, human pace. A kept session that has
  already passed a check is far less likely to be challenged again
  than a fresh automated fetch.
- **A board that still blocks is reported as blocked.** The VM
  returns status `blocked-cloudflare` with a plain-words note, the
  walker records it in the per-board report, and the walk
  **continues to the next board**. A blocked board is never silently
  dropped from the report and never faked as empty or as loads.
- The block is surfaced to the owner in the run's report ("TruLOS
  blocked us today, so the shortlist came from Trucker Path and
  JustTracking"). The owner decides whether to retry later, sign in
  again, or drop the board — the bot never solves a challenge on
  its own and never routes around one.

## Official-API-first rule

**If a board ever offers an official API, use it before the browser.**
No free board checked on 2026-11-19 offers a public API for carrier
load search (DAT/Truckstop search-by-API needs a paid subscription
plus an API add-on; TruckSmarter's API is for brokers to post
loads), so the browser is the route today. If that changes — a free
board publishes an API, or the owner subscribes to a paid board
with API access — the API replaces the browser read for that board,
and this doc and `boards.ts` are updated to say so. The browser is
a fallback, not the preferred way to read a board.

## What is NOT in this design

- No booking, no messaging a broker, no signing — the Scout is
  propose-only, and the browser VM changes nothing about that. The
  VM reads loads; it never acts on them.
- No second browser, no per-bot browsers. One shared VM, one read
  at a time.
- No scraping of the paid boards (DAT, Truckstop, 123Loadboard) or
  the broker apps (TruckSmarter, Uber Freight, Amazon Relay,
  C.H. Robinson, Loadsmart). They are listed in `boards.ts` as
  `LATER_BOARDS` — named, with the reason they are not read — and
  the walker never touches them.
- No animated in-app room, no calling — those are separate phases
  (see `docs/bot-team-build-plan.md`).

## Open items

1. Provision the VM — owner's word needed (new recurring bill,
   ~$7–$8/month estimated).
2. Build the worker itself (the small service on the VM that serves
   `POST /read` and drives the browser) — not in this change.
   The worker build also covers: Xvfb + noVNC and the watch page
   (`GET /watch/:runId`, STOP / TAKE OVER), `POST /stop`, the scan
   scheduler on the VM, and the 5-minute heartbeat posts.
3. Prove `readBoard` against the real worker once it exists — the
   HTTP path is unproven today. Prove `watchUrl`/`stopRun` against
   the real worker the same way.
4. Build the heartbeat endpoint on the main app (receives the VM's
   5-minute heartbeat; flags Scout down in the group chat after 15
   minutes of silence).
5. First board sign-in (Trucker Path, JustTracking) — the owner's
   credentials, entered once on the VM, never shown.
6. Re-check Fly's pricing page at provisioning time — the estimate
   above is dated 2026-11-19 and Fly has already raised RAM prices
   once in October 2026.
