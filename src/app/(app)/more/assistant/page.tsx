"use client";

// Bot intelligence v2 (docs/design/driver-mvp.md §8). The web chat
// window onto the same bot brain as the Telegram bot: same shared
// conversation timeline (Telegram turns show up here, web turns
// show up there), same memories, same knowledge of the business.
// Ask about loads, hours, or money; tell it to log things ("log
// fuel $120 at Pilot"); when it proposes a write itself, reply YES
// or NO to settle it. Nothing is ever sent to anyone from here.
//
// UI/UX upgrade: the page now teaches the interaction instead of
// assuming it - starter-prompt chips (tappable, so the first message
// is never a blank-box problem), a "What the assistant can do" card
// whose every line maps to a tool the agent actually has (full
// omnipresence coverage + dump intake, design §9), chat bubbles, and
// a ?q= prefill so the Ask-the-assistant entry points on Home / Loads
// / Money land with the question already typed.

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { apiClient, ApiClientError } from "@/lib/api-client";
import PageHeader from "@/components/PageHeader";
import { usePageTitle } from "@/lib/use-page-title";
import type { BotChatTurn } from "@/services/ai/bot-chat";

interface ChatResponse {
  reply: string;
  pending_summary: string | null;
}

const STARTER_PROMPTS = [
  "How many hours do I have left today?",
  "What did I earn this week?",
  "Log a fuel stop: $120 at Pilot",
  "What loads do I have coming up?",
];

// Every line maps to a real tool in services/bot (design §9 full
// coverage) - if a capability isn't listed here, the assistant can't
// do it, and the copy must never imply otherwise.
const CAPABILITIES = [
  "Answer from your real numbers — loads, hours, fuel, expenses, money, maintenance, documents",
  "Log things you tell it: fuel, expenses, duty status, a load note, a new record in any tab",
  "Fill any tab from a dump — paste a dispatch thread, rate con, or settlement and get one numbered list to approve, fix, or drop",
  "Remember what you tell it (\"remember: …\") and follow standing instructions you set",
  "Draft dispatch replies in English or Spanish — it never sends anything to anyone",
  "Read your documents, including the text scanned from photos you've uploaded",
];

export default function AssistantPage() {
  return (
    <Suspense fallback={<p>Loading the assistant…</p>}>
      <AssistantInner />
    </Suspense>
  );
}

function AssistantInner() {
  usePageTitle("Assistant");
  const searchParams = useSearchParams();
  const [turns, setTurns] = useState<BotChatTurn[]>([]);
  const [pendingSummary, setPendingSummary] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => searchParams.get("q") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .assistantHistory()
      .then((res) => {
        if (cancelled) return;
        setTurns(res.data);
        setPendingSummary(res.pending_summary);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load the conversation. Try refreshing.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function send(text: string) {
    if (!text || sending) return;
    setError(null);
    setSending(true);
    setTurns((prev) => [...prev, { role: "user", text }]);
    setDraft("");
    try {
      const res: ChatResponse = await apiClient.assistantChat(text);
      setTurns((prev) => [...prev, { role: "assistant", text: res.reply }]);
      setPendingSummary(res.pending_summary);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't send that. Try again.");
    } finally {
      setSending(false);
    }
  }

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await send(draft.trim());
  }

  return (
    <div>
      <PageHeader
        title="Assistant"
        purpose="King — the same assistant as your Telegram bot, one conversation across both. Ask in plain words, or tell it to log something."
      />

      <section aria-label="What the assistant can do">
        <h2>What the assistant can do</h2>
        <ul className="capability-list">
          {CAPABILITIES.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
        <p className="row-sub">
          When it proposes recording something itself, nothing is saved until you reply YES — name item
          numbers to save only those, or NO to drop it. Files themselves still upload under More →
          Documents; paste text here.
        </p>
      </section>

      {pendingSummary && (
        <p role="status" style={{ whiteSpace: "pre-wrap" }}>
          <strong>Waiting on your yes:</strong> {pendingSummary} — reply
          YES to record it (all of it, for a batch), name item numbers
          to record only those, correct one by its number, or say NO
          to drop it.
        </p>
      )}

      {loading ? (
        <p>Loading your conversation…</p>
      ) : turns.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">No conversation yet</p>
          <p>
            This is where you talk to King. Ask what you&apos;ve spent on fuel this week, or tap a starter
            below — you can also just say hello.
          </p>
        </div>
      ) : (
        <div className="chat-list" aria-label="Conversation">
          {turns.map((turn, i) => (
            <p key={i} className={`chat-turn chat-turn-${turn.role}`}>
              {turn.text}
            </p>
          ))}
        </div>
      )}

      <div className="prompt-chips" aria-label="Starter prompts">
        {STARTER_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="prompt-chip"
            disabled={sending}
            onClick={() => void send(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>

      {error && <p role="alert">{error}</p>}

      <form onSubmit={handleSend}>
        <label htmlFor="assistant-message">Message</label>
        <textarea
          id="assistant-message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          required
          placeholder="Ask, or tell me to log something…"
        />
        <button type="submit" disabled={sending}>
          {sending ? "Working…" : "Send"}
        </button>
      </form>
    </div>
  );
}
