// Task 4.5/4.7 (TASKS.md). The escalation surface docs/automation.md's
// Human escalation section requires, computed from industry_briefing_runs
// and attached to GET /api/v1/industry-briefings per docs/api-contracts.md.
export interface ServiceStatus {
  consecutive_failures: number;
  escalated: boolean;
  last_run_at: string | null;
}
