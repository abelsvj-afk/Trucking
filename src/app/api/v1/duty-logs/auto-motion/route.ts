// POST /api/v1/duty-logs/auto-motion (Block A, docs/design/driver-hud-round2.md).
// The app asks to switch the log to Driving because the truck has been detected
// moving for a sustained time while the status said otherwise. This is the ONLY
// automatic status change, it only ever goes INTO Driving, and it only ADDS a row
// from the detection time forward (rules: lib/auto-motion-rules.ts). Idempotent per
// detection. Sends the owner a Telegram notice when it switches. Paper-log helper,
// not an ELD.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createApiHandler } from "@/services/api/handler";
import { validateBody } from "@/services/api/validate";
import { createClient } from "@/services/db/server";
import { judgeAutoMotion, easternClock } from "@/lib/auto-motion-rules";
import { createTelegramNotifier } from "@/services/telegram/notify";
import type { DutyLog } from "@/types/entities";

const bodySchema = z.object({
  detected_at: z.string().min(1),
  submission_id: z.string().uuid(),
});

export const POST = createApiHandler(async (req: NextRequest, ctx) => {
  const { detected_at, submission_id } = await validateBody(req, bodySchema);
  const supabase = await createClient();
  const companyId = ctx.auth.companyId;

  // Replay of the same detection: report the original outcome, never a second row.
  const { data: existing } = await supabase
    .from("duty_logs")
    .select("id")
    .eq("company_id", companyId)
    .eq("submission_id", submission_id)
    .maybeSingle();
  if (existing) return NextResponse.json({ data: { switched: true, deduplicated: true, startedAt: detected_at } });

  const { data: latestRows, error } = await supabase
    .from("duty_logs")
    .select("duty_status, started_at")
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const latest = ((latestRows ?? [])[0] ?? null) as Pick<DutyLog, "duty_status" | "started_at"> | null;

  const verdict = judgeAutoMotion(latest, detected_at, Date.now());
  if (!verdict.ok) return NextResponse.json({ data: { switched: false, reason: verdict.reason } });

  const startedAt = new Date(detected_at).toISOString();
  const note = `Automatic: switched to Driving by detected truck motion at ${easternClock(startedAt)} (moving 5+ mph for 60 s while the log said ${latest!.duty_status.replace("_", " ")}).`;
  const base = {
    company_id: companyId,
    driver_id: null,
    load_id: null,
    duty_status: "driving",
    started_at: startedAt,
    location: null,
    odometer: null,
    notes: note,
    submission_id,
  };
  let insert = await supabase.from("duty_logs").insert({ ...base, source: "auto_motion" });
  if (insert.error && /duty_logs_source_check|violates check constraint/i.test(insert.error.message)) {
    // Migration 00072 not applied yet: the row is still recorded, the note carries the provenance.
    insert = await supabase.from("duty_logs").insert({ ...base, source: "app" });
  }
  if (insert.error) {
    // A second tab/device won the same detection: that is a replay, not a failure.
    if ((insert.error as { code?: string }).code === "23505") {
      return NextResponse.json({ data: { switched: true, deduplicated: true, startedAt } });
    }
    throw new Error(insert.error.message);
  }

  // Best-effort: the in-app notice is shown by the caller either way.
  void createTelegramNotifier()
    .notifyOwner(`Switched to Driving at ${easternClock(startedAt)} — truck moving. (Automatic, from detected motion. If that's wrong, change your status in the app.)`)
    .catch(() => false);

  return NextResponse.json({ data: { switched: true, startedAt } });
});
