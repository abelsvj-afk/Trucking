"use client";

// Driver MVP (docs/design/driver-mvp.md §2 + §5), reworked by the
// Abel forward-fix (§10). Paste a dispatch message (Spanish or
// English) and get the workup: who sent it, what they're actually
// asking, what unclear wording means, a translation ONLY when the
// message is actually in Spanish, and one draft reply in the
// sender's language when a reply is needed. Recordable items the
// helper spots are staged as proposals for your yes - never booked
// silently. The AI drafts - you send. Saving the exchange (with what
// you actually sent) is optional and always your explicit tap; those
// saved exchanges are how the app learns how you write.

import { useState, type FormEvent } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import type { DispatchSuggestion } from "@/services/ai/dispatch";
import type { DispatchExchange } from "@/types/entities";

interface RecordablesOutcome {
  staged: string[];
  rejected: { summary: string; reason: string }[];
  blocked_by_pending: boolean;
}

type DispatchSuggestResponse = DispatchSuggestion & { recordables?: RecordablesOutcome };

export default function DispatchHelperPage() {
  usePageTitle("Dispatch helper");
  const [message, setMessage] = useState("");
  const [context, setContext] = useState("");
  const [suggestion, setSuggestion] = useState<DispatchSuggestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const [actualReply, setActualReply] = useState("");
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuggestion(null);
    setSaved(false);
    setSaveError(null);
    setActualReply("");
    setWorking(true);

    try {
      const result = await apiClient.create<DispatchSuggestResponse>("dispatch-suggest", {
        message,
        context: context || undefined,
      });
      setSuggestion(result);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't process that message. Try again.");
    } finally {
      setWorking(false);
    }
  }

  async function copyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setCopied(null);
    }
  }

  async function handleSaveExchange() {
    if (!suggestion) return;
    setSaveError(null);
    setSaving(true);

    try {
      await apiClient.create<DispatchExchange>("dispatch-exchanges", {
        incoming_message: message,
        ai_translation: suggestion.translation_en,
        ai_suggested_reply_en:
          suggestion.suggested_reply_language === "en" ? suggestion.suggested_reply : null,
        ai_suggested_reply_es:
          suggestion.suggested_reply_language === "es" ? suggestion.suggested_reply : null,
        actual_reply_sent: actualReply || null,
        source: "web",
      });
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiClientError ? err.message : "Couldn't save the exchange. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Dispatch helper"
        purpose="Paste a message from dispatch, the owner, or a broker — Spanish or English. You get who sent it, what they're actually asking, and one draft reply in their language if you need one. Spanish gets translated; English never does. Nothing is ever sent for you."
      />

      <form onSubmit={handleSubmit}>
        <label htmlFor="message">Message you received</label>
        <textarea
          id="message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={6}
          required
          placeholder="Paste the message here…"
        />

        <label htmlFor="context">Anything it should know (optional)</label>
        <input
          id="context"
          value={context}
          onChange={(event) => setContext(event.target.value)}
          placeholder="e.g. This is from Steven, the truck owner"
        />

        {error && <p role="alert">{error}</p>}

        <button type="submit" disabled={working}>
          {working ? "Working…" : "Read it & draft a reply"}
        </button>
      </form>

      {suggestion && (
        <section aria-label="Suggestion">
          <h2>Who this is</h2>
          <p>
            Likely <strong>{suggestion.likely_sender_role}</strong> — {suggestion.sender_reasoning}
          </p>

          <h2>What they&apos;re asking</h2>
          <p>{suggestion.whats_being_asked}</p>

          {suggestion.meaning_notes && (
            <>
              <h2>What they mean</h2>
              <p>{suggestion.meaning_notes}</p>
            </>
          )}

          {suggestion.translation_en && (
            <>
              <h2>Translation</h2>
              <p>{suggestion.translation_en}</p>
            </>
          )}

          {suggestion.suggested_reply && (
            <>
              <h2>
                Suggested reply ({suggestion.suggested_reply_language === "es" ? "Spanish" : "English"})
              </h2>
              <p>{suggestion.suggested_reply}</p>
              <button type="button" onClick={() => copyText("reply", suggestion.suggested_reply!)}>
                {copied === "reply" ? "Copied" : "Copy reply"}
              </button>
            </>
          )}

          {suggestion.recordables && suggestion.recordables.staged.length > 0 && (
            <>
              <h2>Worth recording — staged for your yes</h2>
              <p>
                These were pulled from the message and staged as proposals. Nothing is in your
                books yet — open More → Assistant and reply YES to record them, or NO to drop them.
              </p>
              <ul>
                {suggestion.recordables.staged.map((summary) => (
                  <li key={summary}>{summary}</li>
                ))}
              </ul>
            </>
          )}
          {suggestion.recordables && suggestion.recordables.blocked_by_pending && (
            <p>
              This message also had things worth recording, but another proposal is still waiting
              for your yes/no — settle that one in the Assistant first, then run this message
              again.
            </p>
          )}
          {suggestion.recordables &&
            suggestion.recordables.rejected.map((rejection) => (
              <p key={`${rejection.summary}-${rejection.reason}`}>
                Not staged: {rejection.summary} — {rejection.reason}
              </p>
            ))}

          <h2>Save this exchange</h2>
          <p>
            Saved exchanges teach the app how you actually write. If you
            sent a reply, paste what you really sent - that&apos;s the
            part worth learning from.
          </p>
          <label htmlFor="actual_reply">What I actually sent (optional)</label>
          <textarea
            id="actual_reply"
            value={actualReply}
            onChange={(event) => setActualReply(event.target.value)}
            rows={3}
            placeholder="Paste the reply you actually sent…"
          />
          {saveError && <p role="alert">{saveError}</p>}
          {saved ? (
            <p>Exchange saved.</p>
          ) : (
            <button type="button" onClick={handleSaveExchange} disabled={saving}>
              {saving ? "Saving…" : "Save exchange"}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
