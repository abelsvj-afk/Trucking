# The bot team talks like a team (design, 2026-11-21)

**Status:** DESIGN — waiting on the owner's yes. No code until then (CLAUDE.md workflow).
**Owner's words (2026-11-21):** the bots built after Abel "aren't responding accordingly"; they "need to know their names";
"there shouldn't be a specific way I have to phrase things … or putting things in brackets … even if I spell something
horribly wrong"; "if I … say, find me a load, then the bots need to know that's a job for Scout … literally whatever I say,
they need to know who that work goes to, and … talk to each other whenever their job requires help from another agent";
"think about how [a Grok-style agent platform] works … to run my business autonomously … my agents need all that ability."

## 1. What the owner saw (group chat, 2026-11-21) and why

| Line | Cause in the code |
|---|---|
| "Text only in the group for now — photos and files go to Abel 1:1." ×3, unprompted | Telegram **service messages** (bot added, title changed, pinned) carry no text; `group.ts` treats them as the owner sending a photo. |
| "How's dispatch" / "Scout" / "Scout from Oklahoma" → the same canned "say 'scout, scan from <city, ST>'" | Scout acts only when **regex** finds `scan` / `find … load` / `shortlist` (`isScanRequest`), or a dispatch-shaped message. Everything else gets help text. |
| "Any loads in Oklahoma to Florida?" → Abel: "I'll check … I'll let you know" | "loads" isn't a routing keyword, so it fell to Abel; Abel's group turn has **no tools**, so the model promised work nothing will do. A false promise. |
| "Malik" / "Is he live?" → Abel guesses wrong | Every group turn runs with **`history: []`**: no conversation memory. Abel isn't told who Malik is. |
| "Yes" → "Nothing is waiting on a yes or no right now." | The yes/no grammar answers before any understanding. |
| "Abel: Abel: …", "Dispatch: Scout: Dispatch Scout: …" | The account name AND a text prefix. With every bot on its own account (owner 2026-11-20) the prefix is redundant. |

**Clarity: poor. Authenticity: poor.** Root cause: **who-does-what and what-is-asked are decided by word patterns, and every
turn is answered without the conversation.** More patterns can't fix that.

## 2. The design — one understanding step, then the right bot acts with its own tools

```
owner message ─▶ ignore non-messages ─▶ UNDERSTAND (one cheap model call, with the last ~20 room messages)
                                          │   → who it's for (one or more bots), what is asked, the details
                                          │     (cities, dates, amounts) — typos and any phrasing are fine
                                          ▼
                                   that bot's TURN: its own tools (registry scope), the room history,
                                   its own name and job; answers in plain words from its own account
                                          │
                                          ├─ needs a teammate? → HANDOFF (in the room, by name; the teammate
                                          │   takes its turn the same way; chain cap + one claim per message)
                                          └─ needs a decision/approval? → proposal, the owner's yes (unchanged)
```

### 2.1 Understand (replaces regex routing for the owner's messages)
- One small model call (the cheap "scan" tier, spend-capped like every call) gets: the message, the last ~20 room
  messages, and the **team roster** — each bot's name, nicknames, job in one line, and what it can do.
- It returns strict JSON, validated in code: `{ to: [bot…], ask: "one line", details: {…}, isYesNo, isSmallTalk }`.
  Invalid JSON or an unknown bot = fall back to Abel, said honestly.
- Typos and loose wording are the model's job ("lods frm oklahma to florda" → Scout, origin Oklahoma, destination Florida).
- **Names:** every bot knows its name and nicknames ("Scout", "dispatch", "@DispatchScoutBot"), and its job, from the roster.
- The **regex router stays only as the fallback** when the model is unavailable or the cap is reached — never the main path.
- Deterministic guards stay deterministic: the owner's yes/no still answers a proposal **only when one is waiting and
  the message is clearly about it**; otherwise "yes" is just conversation.

### 2.2 Each bot's turn is a real agent turn
- Each bot runs the **same agent loop as Abel's 1:1** (`runAgentTurn`), with only the tools its registry scope allows
  (least privilege), its own system prompt (name, job, how it talks), and the room history.
- **Scout** gets real tools: `scan_load_boards(origin, destination?, equipment?)` (today's scan, now called by the model
  with the details it understood), `work_up_dispatch(text)`, `lane_rate_history`. Missing cost numbers → he asks once,
  remembers them (as today).
- **Abel** in the group gets his read tools plus `hand_off(to, ask)`. He never promises work he can't do: if no tool or
  teammate can do it, he says so (enforced by a check on the reply: "I'll check / let you know" without a tool call or
  handoff is rewritten to an honest line).
- Malik (phone) is on the roster as a teammate Abel can ask about ("Is Malik live?" → the calling status).

### 2.3 Talking to each other
- `hand_off(to, ask)` posts in the room by name ("Scout, Oklahoma to Florida, dry van — what's out there?") from the
  sender's account, and the teammate takes its turn on it — the same claim, chain cap (4) and loop guard as today.
- A bot that receives work outside its job hands it back or to the right teammate instead of answering wrong.

### 2.4 How they sound
- Plain, short, like a dispatcher texting: no "say '…' and I'll …" command help, no repeated canned lines, no double names
  (the prefix only when a bot has no own account yet).
- Non-messages (service messages, stickers, edits) are ignored silently; a photo gets one short line, once per hour.

## 3. What stays exactly as it is
Proposal-first for every write and every outside action; the owner is the only approver; the spend cap (reserved before
every call); the per-message claim; the chain cap; owner-only room; no slash commands ever (Abel rule).

## 4. Rollout, cost, tests
- **Phase 1 (this change):** understanding step, history, names/roster, Scout + Abel as agent turns with tools,
  `hand_off`, silent non-messages, honest-promise check, no double names. Other bots keep today's handlers but are
  reached through the understanding step.
- **Phase 2:** every other bot (Tracker, Billing, Watchdog, Maintenance, Auditor) moved to agent turns the same way.
- **Cost:** one extra cheap call per owner message (≈ a fraction of a cent), inside the monthly cap.
- **Tests:** the exact 2026-11-21 conversation becomes a test (each line → the right bot, no canned help, no false promise,
  no reply to service messages); a typo matrix ("lods frm oklahma", "scuot", "dispach"); handoff chains at the cap; the
  model-unavailable fallback. Then a live run in the group (King), read line by line for clarity before calling it done.

## 5. Owner decisions needed
1. **Go for Phase 1 as written?**
2. Should a bot ever start work **without** being asked (e.g. Scout scanning when a load is delivered), or only answer?
   Recommendation: only when asked in Phase 1; propose "I can scan for your next load — want me to?" otherwise.
