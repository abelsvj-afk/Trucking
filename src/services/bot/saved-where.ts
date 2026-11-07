// Where did it go? (owner 2026-11-07: Abel "needs to make clear how it saves the information"; design
// docs/design/bot-messages-and-safety.md section 4.) Abel keeps things in two different ways, and every
// confirmation says which:
//   💾 a real RECORD in his app (and the page where he finds it)
//   🧠 something Abel REMEMBERS (his own note - it shapes later answers, but is not an app record)

type Where = { kind: "record" | "memory" | "removed"; page: string };

const RULES: Array<[RegExp, Where]> = [
  [/^delete_record$/, { kind: "removed", page: "" }],
  [/^(?:save_memory|set_pay_pin|save_game_assumption|propose_person_model|record_sent_reply|record_load_decision|record_forward_thread|set_game_target)$/, { kind: "memory", page: "" }],
  [/^set_pay_terms$/, { kind: "record", page: "Settings → Pay terms" }],
  [/load_invoice/, { kind: "record", page: "Money → Invoices" }],
  [/(?:^|_)load(?:_note)?$|^complete_load$|^add_load_note$/, { kind: "record", page: "Loads" }],
  [/expense/, { kind: "record", page: "Money → Expenses" }],
  [/fuel_purchase/, { kind: "record", page: "Money → Fuel" }],
  [/recurring_obligation/, { kind: "record", page: "Money → Recurring bills" }],
  [/maintenance/, { kind: "record", page: "Maintenance" }],
  [/vehicle_defect|pretrip/, { kind: "record", page: "Trucks → Inspections & defects" }],
  [/_truck$/, { kind: "record", page: "Trucks" }],
  [/_trailer$/, { kind: "record", page: "Trailers" }],
  [/_driver$/, { kind: "record", page: "Drivers" }],
  [/_broker(?:_followup)?$/, { kind: "record", page: "Contacts → Brokers" }],
  [/_customer$/, { kind: "record", page: "Contacts → Customers" }],
  [/_facility$/, { kind: "record", page: "Contacts → Facilities" }],
  [/credential/, { kind: "record", page: "Credentials" }],
  [/checklist/, { kind: "record", page: "Trucks → Checklist" }],
  [/duty_status|detention/, { kind: "record", page: "Logs" }],
  [/attach_document/, { kind: "record", page: "Documents" }],
  [/mark_thread_answered/, { kind: "record", page: "Threads" }],
  [/settlement/, { kind: "record", page: "Money → Settlements" }],
];

/** The one line that tells him how and where a confirmed change was kept. */
export function savedWhere(tool: string): string {
  const hit = RULES.find(([pattern]) => pattern.test(tool))?.[1];
  if (!hit) return "💾 Saved to your app.";
  if (hit.kind === "memory") return "🧠 Remembered - this is my own note, not an app record. It shapes my later answers.";
  if (hit.kind === "removed") return "🗑️ Removed from your app (a soft delete - it can be restored).";
  return `💾 Saved to your app → ${hit.page}.`;
}
