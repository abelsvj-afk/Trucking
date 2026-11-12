"use client";

// Lane 2 (Abel Intelligence Upgrade, Phase B) — "What Abel
// remembers". Audit B-3: before this page there was NO surface
// anywhere to see, correct, or remove what the bot had stored.
// One list over the same shared brain store the Telegram bot and
// the web Assistant both read.
//
// Editing follows the memory lifecycle: a correction is saved as a
// NEW memory that supersedes the old one (the old wording stays in
// history, marked replaced) - Abel never silently rewrites what he
// used to believe. Delete is a soft delete.

import { useCallback, useEffect, useState } from "react";
import {
  apiClient,
  ApiClientError,
  type BotConsolidationStatus,
  type BotMemoryListItem,
} from "@/lib/api-client";
import type { WhatIKnowModel } from "@/services/bot/what-i-know";
import { ListLoading, ListError } from "@/components/ListStates";
import { usePageTitle } from "@/lib/use-page-title";
import PageHeader from "@/components/PageHeader";
import { formatDate, formatDateTime } from "@/lib/time";

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "loaded";
      memories: BotMemoryListItem[];
      consolidation: BotConsolidationStatus | null;
      model: WhatIKnowModel | null;
    };

const KIND_LABELS: Record<string, string> = {
  fact: "Fact",
  note: "Note",
  expense_hint: "Expense hint",
  instruction: "Standing instruction",
  person_profile: "Person profile",
  business_fact: "Business fact",
  game_assumption: "Game Plan assumption",
};

export default function MemoriesPage() {
  usePageTitle("What Abel remembers");
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [showHistory, setShowHistory] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editingLessonId, setEditingLessonId] = useState<string | null>(null);
  const [lessonDraft, setLessonDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      apiClient.listMemories(showHistory),
      // Frontier 2: the model view rides the same load — a failure
      // here only omits the model section, never the memory list.
      apiClient.getWhatIKnow().catch(() => null),
    ])
      .then(([result, model]) =>
        setState({
          status: "loaded",
          memories: result.data,
          consolidation: result.consolidation,
          model: model?.data ?? null,
        }),
      )
      .catch((err: unknown) => {
        const message =
          err instanceof ApiClientError ? err.message : "Couldn't reach the server. Try again.";
        setState({ status: "error", message });
      });
  }, [showHistory]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveEdit(id: string) {
    setBusy(true);
    setActionError(null);
    try {
      await apiClient.editMemory(id, draft.trim());
      setEditingId(null);
      load();
    } catch (err) {
      setActionError(
        err instanceof ApiClientError ? err.message : "That edit didn't save. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setActionError(null);
    try {
      await apiClient.deleteMemory(id);
      load();
    } catch (err) {
      setActionError(
        err instanceof ApiClientError ? err.message : "That delete didn't go through. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  // Frontier 2: correcting a lesson saves the new version as a
  // superseding row at max confidence (his word) and keeps the old
  // one in history — same close-not-delete rule as memories.
  async function saveLessonCorrection(id: string) {
    setBusy(true);
    setActionError(null);
    try {
      await apiClient.correctLesson(id, lessonDraft.trim());
      setEditingLessonId(null);
      load();
    } catch (err) {
      setActionError(
        err instanceof ApiClientError ? err.message : "That correction didn't save. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="What Abel remembers"
        purpose="Everything Abel has stored about you and your business — the same memory he uses on Telegram and here. Correcting a memory saves the new version and keeps the old one in history (marked replaced), so nothing he believed ever vanishes silently."
      />
      <label>
        <input
          type="checkbox"
          checked={showHistory}
          onChange={(event) => setShowHistory(event.target.checked)}
        />{" "}
        Show replaced memories (history)
      </label>

      {state.status === "loading" && <ListLoading />}
      {state.status === "error" && <ListError message={state.message} onRetry={load} />}
      {actionError && <p role="alert">{actionError}</p>}

      {/* Fix round (pitfall hunt CD-1): the night shift runs on its
          own schedule - if it has silently stopped (the app was
          asleep for days), that must be visible somewhere the owner
          actually looks. Shown only when consolidation is enabled,
          its state is known, and the last run is stale. */}
      {state.status === "loaded" &&
        state.consolidation?.enabled &&
        state.consolidation.known &&
        state.consolidation.stale && (
          <p role="alert">
            Heads up: Abel&rsquo;s night shift{" "}
            {state.consolidation.lastRanAt
              ? `hasn&rsquo;t run since ${formatDateTime(state.consolidation.lastRanAt, "America/New_York")} — `
              : "has never run — "}
            so his weekly summaries and memory proposals are behind. It&rsquo;s supposed to run on
            its own every night; if this notice is still here tomorrow, the consolidation scheduler
            isn&rsquo;t waking up.
          </p>
        )}

      {state.status === "loaded" && state.memories.length === 0 && (
        <p>Nothing stored yet. Tell Abel something worth keeping — in chat or with “remember:” — and it will show up here.</p>
      )}

      {/* Frontier 2: "What I know about you" — beliefs +
          preferences (current memories, grouped) and lessons (current
          agent episodes, each with its evidence and a Correct
          button). Same page, same consolidation banner above. */}
      {state.status === "loaded" && state.model && (
        <section>
          <h2>What I know about you</h2>
          <p>
            What Abel believes about you and your business, what you prefer, and what he has
            learned from working with you — each lesson shows the evidence behind it. Correcting
            a lesson saves the new version and keeps the old one in history, so nothing he
            believed ever vanishes silently.
          </p>
          {state.model.beliefs.length > 0 && (
            <div>
              <h3>Beliefs</h3>
              <ul>
                {state.model.beliefs.map((belief) => (
                  <li key={belief.id}>
                    <strong>{KIND_LABELS[belief.kind] ?? belief.kind}</strong>{" "}
                    <span>{formatDate(belief.created_at, "America/New_York")}</span>
                    <p>{belief.content}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {state.model.preferences.length > 0 && (
            <div>
              <h3>Preferences</h3>
              <ul>
                {state.model.preferences.map((preference) => (
                  <li key={preference.id}>
                    <p>{preference.content}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {state.model.lessons.length > 0 && (
            <div>
              <h3>Lessons I&rsquo;ve learned</h3>
              <ul>
                {state.model.lessons.map((lesson) => (
                  <li key={lesson.id}>
                    <div>
                      <strong>{lesson.kind}</strong>{" "}
                      <span>{formatDate(lesson.created_at, "America/New_York")}</span>
                    </div>
                    {editingLessonId === lesson.id ? (
                      <div>
                        <textarea
                          value={lessonDraft}
                          onChange={(event) => setLessonDraft(event.target.value)}
                          rows={3}
                          cols={60}
                        />
                        <div>
                          <button type="button" disabled={busy || !lessonDraft.trim()} onClick={() => void saveLessonCorrection(lesson.id)}>
                            Save correction
                          </button>{" "}
                          <button type="button" disabled={busy} onClick={() => setEditingLessonId(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <p>{lesson.lesson ?? lesson.summary}</p>
                        {lesson.evidence && <p>Evidence: {lesson.evidence}</p>}
                        <div>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setEditingLessonId(lesson.id);
                              setLessonDraft(lesson.lesson ?? lesson.summary);
                            }}
                          >
                            Correct
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {state.model.beliefs.length === 0 &&
            state.model.preferences.length === 0 &&
            state.model.lessons.length === 0 && (
              <p>No beliefs, preferences, or lessons yet — the model fills in as Abel learns.</p>
            )}
        </section>
      )}

      {state.status === "loaded" && state.memories.length > 0 && (
        <ul>
          {state.memories.map((memory) => {
            const replaced = memory.valid_to !== null;
            return (
              <li key={memory.id}>
                <div>
                  <strong>{KIND_LABELS[memory.kind] ?? memory.kind}</strong>{" "}
                  <span>
                    {formatDate(memory.created_at, "America/New_York")}
                    {replaced ? " · replaced" : ""}
                  </span>
                </div>
                {editingId === memory.id ? (
                  <div>
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={3}
                      cols={60}
                    />
                    <div>
                      <button type="button" disabled={busy || !draft.trim()} onClick={() => void saveEdit(memory.id)}>
                        Save correction
                      </button>{" "}
                      <button type="button" disabled={busy} onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <p>{memory.content}</p>
                    {!replaced && (
                      <div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEditingId(memory.id);
                            setDraft(memory.content);
                          }}
                        >
                          Correct
                        </button>{" "}
                        <button type="button" className="button-danger-quiet" disabled={busy} onClick={() => void remove(memory.id)}>
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
