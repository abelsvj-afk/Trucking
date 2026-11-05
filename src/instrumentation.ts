// Task 4.3 (TASKS.md). Next.js's own supported "run this once when the
// server starts" hook (docs/runtime.md) - this is what actually starts
// the industry-intelligence scheduler. Guarded to the Node.js runtime
// only: this file's register() also gets called under the Edge runtime
// in some configurations, and the scheduler's dependencies (`pg`, the
// OpenAI SDK) aren't Edge-compatible and have no reason to run there.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startIndustryBriefingScheduler } = await import("@/services/ai/scheduler");
    startIndustryBriefingScheduler();
    // Deep Research Engine (docs/design/research-engine.md §9) - same
    // in-process scheduler pattern as the industry-briefing job above.
    const { startResearchScheduler } = await import("@/services/research/scheduler");
    startResearchScheduler();
    // Gaming System (docs/design/gaming-system.md §4) - same
    // in-process scheduler pattern: monthly checkpoint closes +
    // daily data-trigger re-games, all due-ness from DB state.
    const { startGameScheduler } = await import("@/services/game/scheduler");
    startGameScheduler();
    // Abel memory consolidation (Intelligence Upgrade Phase B) -
    // same in-process pattern: nightly embed/summarize/stage pass,
    // due-ness from consolidation_runs, kill-switched in Settings.
    const { startConsolidationScheduler } = await import("@/services/bot/consolidation-scheduler");
    startConsolidationScheduler();
    // Abel weekly pay-truth report (Intelligence Upgrade Phase D) -
    // same in-process pattern: hourly due-check against
    // pay_report_runs, one report per completed Mon-Sun week.
    const { startPayReportScheduler } = await import("@/services/bot/pay-report-scheduler");
    startPayReportScheduler();
    // Maintenance watcher (Image Intelligence §5.6) - same
    // in-process pattern: a ~6-hourly evaluation pass whose
    // due-ness comes from maintenance_watch_runs; it also rides
    // the research endpoint's hourly invoker (its second door).
    const { startMaintenanceWatchScheduler } = await import("@/services/fleet/maintenance-watch");
    startMaintenanceWatchScheduler();
    // Proactive logging reminders (docs/design/logging-reminders.md) - every
    // 5 minutes, behind the logging_reminders switch (off by default).
    const { startReminderScheduler } = await import("@/services/bot/reminder-scheduler");
    startReminderScheduler();
  }
}
