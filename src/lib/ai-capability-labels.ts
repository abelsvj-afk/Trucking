// The words on each AI kill switch (Settings > Abel and AI). Kept in one place so the settings page and the
// authority-matrix drift test read the same list (docs/ai-authority-matrix.md section 2).

export const CAPABILITY_LABELS: Record<string, string> = {
  industry_intelligence: "Industry intelligence briefings",
  dispatch_helper: "Dispatch helper (translation + reply drafts)",
  bot_chat: "Bot chat (Telegram + web assistant)",
  deep_research: "Deep research engine (watches fuel, rules & news; briefs you when pressure hits)",
  document_extraction: "Document text extraction (reads uploaded paperwork so the assistant can answer questions about it)",
  game_plan: "Game Plan (your target + strategy planner — games your real numbers into a path to the target; projections, never promises)",
  memory_consolidation: "Memory night shift (nightly pass that organizes Abel's memory and stages things he noticed in your chats as proposals for your yes/no — never saves anything on its own)",
  voice_transcription: "Voice transcription (Abel turns your Telegram voice notes into text and works them like typed messages — audio goes to the transcription provider; typical cost is under a cent per note, or free when a free-tier provider is configured)",
  driver_twin: "Driver twin (on Telegram, Abel drafts dispatch replies using your own past sent replies as examples, and tracks how much you edit his drafts — web dispatch drafts don't use the twin yet; off means no examples in drafts and no edit tracking)",
  photo_intelligence: "Photo understanding (when you send Abel a photo, he figures out what it's for — paperwork, the truck, a trailer, the dash, a pre-trip — and asks you with one tap when he isn't sure; off means photos are just filed as documents, like before)",
  live_location: "Live Location (when you share your live location with Abel in Telegram, he keeps only your latest position — it keeps working with the app closed — and may ASK whether to change your duty status when the truck stops for 5 minutes while you're logged Driving; on by default because you start it by sharing; off means nothing is stored and nothing is proposed)",
  auto_duty_switch: "Automatic switch to Driving (when the truck has been moving about a minute and a half while your log says anything but Driving, the app logs Driving for you from the moment it noticed — from the open app or from your Telegram live location with the app closed — and messages you. It only ever switches INTO Driving, never changes earlier entries, and a status you set by hand while moving wins. Planning only, not an ELD. On by default; off means it never changes your log on its own)",
  logging_reminders: "Logging reminders (Abel messages you when a driving, 14-hour, break or cycle clock is about to run out by your own logged hours — 2 hours, 1 hour, 30 minutes and 0 left, with what it means and what to do, even at night — and, in the morning, when your log still says Driving long after it could be true; he only informs or asks, never changes your status; planning only, not an ELD; off by default)",
  maintenance_watch: "Maintenance reminders (Abel watches your maintenance schedules and open defects in the background and messages you when something is due, overdue, or going stale — one digest a day at most, urgent safety/legal items right away; off means he only answers when you ask)",
};
