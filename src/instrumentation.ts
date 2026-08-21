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
  }
}
