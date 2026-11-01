"use client";

// Driver MVP (docs/design/driver-mvp.md §2 + §5). Paste a dispatch
// message (Spanish or English), get the translation, a plain read of
// what's being asked and who sent it, and a draft reply in both
// languages. The AI drafts - you send. Saving the exchange (with what
// you actually sent) is optional and always your explicit tap; those
// saved exchanges are how the app learns how you write.

import { useState, type FormEvent } from "react";
import { apiClient, ApiClientError } from "@/lib/api-client";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import type { DispatchSuggestion } from "@/services/ai/dispatch";
import type { DispatchExchange } from "@/types/entities";

export default function DispatchHelperPage() {
  usePageTitle("Dispatch helper");
  const [message, setMessage] = useState("");
  const [context, setContext] = useState("");
  const [suggestion, setSuggestion] = useState<DispatchSuggestion | null>(null);
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
      const result = await apiClient.create<DispatchSuggestion>("dispatch-suggest", {
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
        ai_suggested_reply_en: suggestion.suggested_reply_en,
        ai_suggested_reply_es: suggestion.suggested_reply_es,
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
        purpose="Paste a message from dispatch, the owner, or a broker — Spanish or English. You get the translation, what they're actually asking, and a draft reply in both languages. Nothing is ever sent for you."
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
          {working ? "Working…" : "Translate & draft a reply"}
        </button>
      </form>

      {suggestion && (
        <section aria-label="Suggestion">
          <h2>Translation</h2>
          <p>{suggestion.translation_en}</p>

          <h2>What they&apos;re asking</h2>
          <p>{suggestion.whats_being_asked}</p>
          <p>
            Likely who this is: <strong>{suggestion.likely_sender_role}</strong> —{" "}
            {suggestion.sender_reasoning}
          </p>

          <h2>Suggested reply (English)</h2>
          <p>{suggestion.suggested_reply_en}</p>
          <button type="button" onClick={() => copyText("en", suggestion.suggested_reply_en)}>
            {copied === "en" ? "Copied" : "Copy English reply"}
          </button>

          <h2>Suggested reply (Spanish)</h2>
          <p>{suggestion.suggested_reply_es}</p>
          <button type="button" onClick={() => copyText("es", suggestion.suggested_reply_es)}>
            {copied === "es" ? "Copied" : "Copy Spanish reply"}
          </button>

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
