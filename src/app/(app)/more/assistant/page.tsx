"use client";

// Bot intelligence v2 (docs/design/driver-mvp.md §8). The web chat
// window onto the same bot brain as the Telegram bot: same shared
// conversation timeline (Telegram turns show up here, web turns
// show up there), same memories, same knowledge of the business.
// Ask about loads, hours, or money; tell it to log things ("log
// fuel $120 at Pilot"); when it proposes a write itself, reply YES
// or NO to settle it. Nothing is ever sent to anyone from here.

import { useEffect, useState, type FormEvent } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePageTitle } from "@/lib/use-page-title";
import type { BotChatTurn } from "@/services/ai/bot-chat";

interface ChatResponse {
  reply: string;
  pending_summary: string | null;
}

export default function AssistantPage() {
  usePageTitle("Assistant");
  const [turns, setTurns] = useState<BotChatTurn[]>([]);
  const [pendingSummary, setPendingSummary] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
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

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setError(null);
    setSending(true);
    setTurns((prev) => [...prev, { role: "user", text }]);
    setDraft("");
    try {
      const res = await apiClient.assistantChat(text);
      setTurns((prev) => [...prev, { role: "assistant", text: res.reply }]);
      setPendingSummary(res.pending_summary);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't send that. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <h1>Assistant</h1>
      <p>
        The same assistant as your Telegram bot - one conversation
        across both. Ask about your loads, hours, or money; tell it
        to log things (&quot;log fuel $120 at Pilot&quot;); when it
        suggests recording something itself, reply YES or NO.
      </p>

      {pendingSummary && (
        <p role="status">
          <strong>Waiting on your yes:</strong> {pendingSummary} - reply
          YES to record it, or NO to drop it.
        </p>
      )}

      {loading ? (
        <p>Loading your conversation…</p>
      ) : turns.length === 0 ? (
        <p>No conversation yet - say hello, or ask what you&apos;ve spent on fuel this week.</p>
      ) : (
        <section aria-label="Conversation">
          {turns.map((turn, i) => (
            <p key={i}>
              <strong>{turn.role === "user" ? "You" : "King"}:</strong> {turn.text}
            </p>
          ))}
        </section>
      )}

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
