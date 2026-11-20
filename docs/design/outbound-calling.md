# Abel outbound phone calling (owner 2026-11-17)

Abel has to be able to MAKE phone calls, not just text — drivers can't answer texts while driving. Model: the Blue Bonnet AI that called him 2026-11-16 about an order (ETA + info), sounding nearly human. The reason for a call always comes from what's in the app (load, ETA, hours, delivery).

## The one number

One US local number on the app's Telnyx account is the caller ID for Abel AND every future driver bot. Calls take turns through it: one call at a time per company, the next waits its turn and Abel says so. No number per driver. Each driver's own Telegram bot (created through the in-app walkthrough, on their own Telegram account — a separate build) shares this same number through the same backend.

Telegram bots cannot place calls, ever — the Bot API has no calling. The call goes out over the regular phone network from the shared number, driven by the app's backend.

## Voice path decision: Telnyx AI Assistants, not Conversation Relay

Two Telnyx paths cost the same $0.05/min. Only one ships inside this app's deploy model:

- **Conversation Relay** streams transcribed text in and takes text out over one WebSocket — Telnyx does STT, TTS and turn-taking, our app drives the conversation with its own LLM. That is the better fit for "the app's own reasoning", BUT it needs Telnyx to open a WebSocket to OUR `wss://` URL. This app is `next start` only: no WebSocket server, no custom server, a single `app` process in fly.toml. Standing one up would be a second service plus a deploy-model change. NOT in this build.
- **AI Assistants (GA)** needs only HTTPS: the app dials through Call Control, Telnyx runs the assistant, webhooks come back to the app's existing Next routes. Same $0.05/min, no new infrastructure.

Stated plainly: with AI Assistants the conversation is driven by the Telnyx-hosted assistant — configured with the OpenAI model family the app already uses, instructions written from the app's knowledge, dynamic variables per call (load, ETA, names, purpose), and tools that call back into the app's HTTP API — NOT by the app's own agent-loop turn by turn. Conversation Relay with the app's agent loop is the documented follow-up if he ever wants the conversation driven from inside the app.

## The voice — he picks it

- **Default: Telnyx built-in voice.** Included in the $0.05/min assistant minute. No extra cost, no extra account.
- **ElevenLabs voice (his choice):** his ElevenLabs API key is stored as a Telnyx Integration Secret — pasted in the Telnyx portal, never in the repo, never in chat. The assistant references it by name. **The key stays as-is: KEEP the existing key, no rotation (owner 2026-11-17, explicit — "we can keep the same key").** Do not rotate it, do not re-request one, do not raise it again. Per-call override: `ai_assistant_start` carries `voice_settings`, so the voice he picked is applied to that call.

## Natural sound — owner hard rule (2026-11-17)

"Make sure to still make it sound natural." How this build meets it:

- **Complete sentences only.** The app never sends word fragments to TTS. The assistant speaks full sentences, and the turn loop only speaks a sentence once it is complete.
- **Fixed phrases are constant full sentences.** The greeting, the voicemail message, and the closing are fixed text, rendered identically every call — never re-composed from pieces, never stitched.
- **Assistant instructions require it** (see below): conversational pace, no reading IDs, codes, or lists aloud, no rushing, say plainly when it doesn't know.
- **ElevenLabs (his picked voice) is the natural-sounding option** — it renders full-sentence prosody. The Telnyx built-in voice is the fallback, not the natural-sounding pick.

## Recommended assistant instructions (paste into the Telnyx portal assistant)

```
You are Abel, the dispatcher assistant for Road to Legacy Trucking. You are calling {{to_name}} about {{purpose}}.
Speak like a person talking on the phone, not like a robot reading a script. Use complete, natural sentences. Keep it short and to the point. Never read out IDs, codes, reference numbers, or lists unless the person asks. If they ask something you don't know, say so plainly and offer to have the driver call back — never guess.
What you need to get across: {{say}}
When they confirm or answer, repeat it back once in plain words so they know you heard it, then wrap up: "Thanks, I'll pass that along." and end the call.
If you reach voicemail, leave this message: "Hi, this is Abel calling from Road to Legacy Trucking about {{purpose}}. Please call us back at {{from_number}}. Thanks."
```
- **How he picks:** Settings → Abel and AI → "Voice on calls". A dropdown listing Telnyx built-in voices plus ElevenLabs voices (fetched live from the Telnyx Voices API when Telnyx is configured). The pick is stored as `companies.call_voice_id` (null = Telnyx default). A setting, not code.
- **ElevenLabs limits, honestly:** Telnyx docs say free-plan ElevenLabs keys are rejected — his account is Starter (paid, 40,000 characters/month as of 2026-10-15). Verify at signup; if Telnyx rejects the key, the setting falls back to Telnyx built-in and the UI says so. Speech runs about 800 characters a minute, so a 3-minute call uses about 2,400 characters — roughly 16 such calls a month on Starter. Past that he needs a bigger ElevenLabs plan; the Telnyx voice has no such quota.

## What a call costs (verified 2026-11-17, US list prices)

| Item | Cost |
|---|---|
| Telnyx local number | $1.00 / month |
| Outbound call leg | ~$0.007 / min |
| AI Assistant minute (orchestration, STT, TTS) | $0.05 / min |
| LLM tokens (OpenAI model, via his OpenAI key ref) | billed separately, pennies per call |
| ElevenLabs voice (if picked) | his Starter quota: ~2,400 chars per 3-min call |
| Telnyx built-in voice (default) | $0 extra |

A 3-minute call on the Telnyx voice: about $0.17 plus LLM pennies. Same call on an ElevenLabs voice: the same, plus ~2,400 characters of his ElevenLabs quota. The trial is free for 30 days (one number, 10 outbound calls a day up to 10 minutes each, calls only to numbers he verifies).

## How a call happens

1. Abel decides a call is needed (or the owner asks for one) and proposes it: who, why, what Abel will say. **Every call is proposed first** — a call to a third party can't be unsaid, so it sits in the same always-propose class as the dump-staging writes. One tap on Yes dials.
2. The proposal is checked in code before it is shown: the number must be one the app already knows (a driver, broker, or customer on file, or a party on the active load). Unknown numbers are refused, never dialed.
3. On Yes, the call is queued in `outbound_calls` (status `queued`). The queue claims it atomically — one call at a time per company — and dials through Telnyx Call Control with the AI assistant attached (greeting + purpose + dynamic variables + his picked voice).
4. Telnyx webhooks report back: answered, no answer, voicemail, hangup, conversation ended, insights generated. The transcript and outcome land on the call row. When a call ends, the webhook claims the next queued call.
5. Abel can answer "did you call them?" from `list_outbound_calls` — the app is his proof vault.

## Kill switch

`outbound_calling` is a capability in Settings → Abel and AI, default OFF (fail-closed, like every other capability — no row means off). The owner flips it on once. Turning it off stops new calls — including ones already queued: the dialer itself reads the switch right before Telnyx (`canPlaceOutboundCall`, audit F-005), so the tool, the webhook's queue drain and any retry all stop, and a queued call is marked failed with "Not dialed: …". It never interrupts one in progress. The global AI switch also gates it.

## Setup checklist (account lane, separate from this code)

1. Telnyx trial account under owner@roadtolegacytrucking.com (no card for the trial).
2. Call Control Application + connection ID; webhook URL points at `/api/telnyx/webhook`.
3. AI Assistant created (OpenAI model + instructions + ElevenLabs voice secret, if he picks an ElevenLabs voice).
4. One US local number bought on the account (first month free after upgrade; trial number is shared and can't be kept).
5. Fly secrets: `TELNYX_API_KEY`, `TELNYX_PHONE_NUMBER`, `TELNYX_CONNECTION_ID`, `TELNYX_ASSISTANT_ID`, `TELNYX_PUBLIC_KEY` (webhook signature). Never in the repo.
6. First live test call goes ONLY to his verified number, on his word, after the trial account exists. The gate does NOT include a live call — tests use a fake Telnyx client and never hit the live API.

## Out of scope

- Per-driver Telegram bot walkthrough changes (separate build).
- Inbound calls (someone calling the number back) — later.
- Keeping/porting the number after trial, A2P 10DLC registration, STIR/SHAKEN — upgrade-time decisions, on his word.
- Conversation Relay with the app's own agent loop — documented follow-up, needs a WebSocket server (deploy-model change).
- Any change to pay, hours, loads, or Telegram messaging behavior.

## Call state machine (audit F-006 / F-017, 2026-11-20)

Telnyx retries webhooks and sends `call.hangup` **and** `call.conversation.ended` for the same call, in either order; the insights event (transcript + summary) usually comes last. One pure function decides every change: `nextCallState` in `src/lib/call-state.ts`.

| Event | From queued / dialing / in_progress | From a final state (completed, failed, no_answer, voicemail) |
|---|---|---|
| `call.answered` | → in_progress (first `started_at` kept) | nothing |
| `call.conversation.ended` | → completed, `ended_at` | nothing |
| `call.hangup` | → completed (normal clearing) or failed (`Call ended: <cause>`), `ended_at`, duration | nothing |
| `call.conversation_insights.generated` | fills transcript / summary | fills transcript / summary (never blanks them) |

- **Final is final.** A late or repeated event never reopens or re-ends a call.
- **One finisher.** The move into a final state is written with a status filter (`finishOutboundCall`: update only while not final), so of two deliveries racing to finish the same call exactly one wins — and only that one dials the next queued call.
- **Failed assistant start.** The outbound leg is already ringing when the AI assistant is attached; if attaching fails, the dialer hangs that leg up (`hangupCall`) and records it, so nobody answers to silence and the shared number is freed. A failed hangup is written on the row, not hidden.
