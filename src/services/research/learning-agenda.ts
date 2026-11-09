// Self-directed learning agenda (docs/design/autonomous-research.md
// §4): the tick-side pass that turns knowledge gaps into PROPOSED
// learning topics, and the settle hook the runner calls when an
// approved topic's research run finishes. Filing a proposal is all
// this module ever does autonomously - running anything still takes
// the owner's yes (approve_learning_topic in chat, or the Research
// page button), and approval queues a normal manual research run
// under the engine's caps. Proposals are deduped in code against
// open rows (proposed/queued) for the same company + watch topic.

import { detectLearningGaps, type TopicKnowledgeState } from "@/lib/learning-gaps";
import { WATCH_TOPICS, type WatchTopic } from "@/lib/watch-topics";
import type { Queryable } from "@/services/ai/run-industry-briefing";
import { loadLatestKnowledgeByTopic } from "./knowledge";

export interface LearningTopicRow extends Record<string, unknown> {
  id: string;
  topic: string;
  reason: string;
  watch_topic: WatchTopic | null;
  proposed_by: string;
  status: string;
  research_run_id: string | null;
  created_at: string;
  decided_at: string | null;
}

const TOPIC_COLUMNS =
  "id, topic, reason, watch_topic, proposed_by, status, research_run_id, created_at, decided_at";

function isMissingTable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /research_learning_topics/.test(message) && /does not exist|could not find|relation/i.test(message);
}

/** Open (proposed or queued) agenda rows for one company, newest first. */
export async function loadOpenLearningTopics(db: Queryable, companyId: string): Promise<LearningTopicRow[]> {
  const { rows } = await db.query<LearningTopicRow>(
    `select ${TOPIC_COLUMNS}
     from research_learning_topics
     where company_id = $1 and status in ('proposed', 'queued')
     order by created_at desc`,
    [companyId],
  );
  return rows;
}

/**
 * One agenda pass for one company: read knowledge freshness per
 * standing topic, detect gaps, file up to `maxProposals` new PROPOSED
 * rows. Returns how many were filed. Never queues a run.
 */
export async function runLearningAgendaPass(
  db: Queryable,
  companyId: string,
  maxProposals: number,
  now: Date = new Date(),
): Promise<number> {
  let latest: Partial<Record<WatchTopic, { observed_at: string }>>;
  let open: LearningTopicRow[];
  try {
    latest = await loadLatestKnowledgeByTopic(db, companyId);
    open = await loadOpenLearningTopics(db, companyId);
  } catch (err) {
    if (isMissingTable(err)) {
      console.error("[research] learning agenda skipped - migration 00084 is not applied yet");
      return 0;
    }
    throw err;
  }

  const openTopics = new Set(open.map((t) => t.watch_topic).filter((t): t is WatchTopic => t !== null));
  const states: TopicKnowledgeState[] = WATCH_TOPICS.map((topic) => ({
    topic,
    latestObservedAt: latest[topic]?.observed_at ?? null,
    hasOpenProposal: openTopics.has(topic),
  }));

  const gaps = detectLearningGaps(states, now).slice(0, Math.max(0, maxProposals));
  let filed = 0;
  for (const gap of gaps) {
    const { rows } = await db.query<{ id: string }>(
      `insert into research_learning_topics (company_id, topic, reason, watch_topic, proposed_by, status)
       values ($1, $2, $3, $4, 'abel', 'proposed')
       returning id`,
      [companyId, gap.topic, gap.reason, gap.watchTopic],
    );
    if (rows[0]) filed += 1;
  }
  return filed;
}

/**
 * Runner settle hook: when a research run that an approved learning
 * topic queued reaches ANY terminal state, the topic is 'done' - the
 * run's own row carries the honest outcome (success, failure,
 * insufficient_data), and the agenda never pretends a failed run
 * taught anything. Best-effort: a missing table (pre-00084) or a
 * failed update logs and never disturbs the run's own bookkeeping.
 */
export async function settleLearningTopicForRun(db: Queryable, runId: string): Promise<void> {
  try {
    await db.query(
      `update research_learning_topics
       set status = 'done'
       where research_run_id = $1 and status = 'queued'`,
      [runId],
    );
  } catch (err) {
    if (!isMissingTable(err)) {
      console.error("[research] learning topic settle failed", err);
    }
  }
}
