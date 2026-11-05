// The maintenance interval library (Image Intelligence design
// §5.1): code, not a table - versioned with the app, unit-tested,
// and owned by nobody's database row. These are STARTING POINTS
// from typical manufacturer / fleet guidance for a Class 8 diesel,
// and every surface that presents them says exactly that. They are
// never represented as his carrier's figures or as the
// truck's own manual speaking.
//
// A schedule row created from a template carries template_key +
// origin='template', which is what lets a recorded maintenance
// event find and advance its schedule (§5.4).

export interface MaintenanceTemplate {
  key: string;
  /** The schedule description as it lands on the row. */
  label: string;
  intervalMiles: number | null;
  intervalDays: number | null;
  /** Safety/legal items escalate harder in the watcher (§5.6). */
  safety: boolean;
  /** Words an owner's free-text work description might use - the §5.4 fallback match, always labeled a guess. */
  keywords: string[];
}

export const MAINTENANCE_TEMPLATES: MaintenanceTemplate[] = [
  { key: "engine_oil", label: "Engine oil & filter", intervalMiles: 15_000, intervalDays: 180, safety: false, keywords: ["oil change", "engine oil", "oil and filter", "oil & filter"] },
  { key: "fuel_filters", label: "Fuel filters", intervalMiles: 15_000, intervalDays: 180, safety: false, keywords: ["fuel filter"] },
  { key: "chassis_lube", label: "Chassis lube / grease", intervalMiles: 15_000, intervalDays: 180, safety: false, keywords: ["lube", "grease", "chassis"] },
  { key: "brake_inspection", label: "Brake inspection", intervalMiles: 15_000, intervalDays: 180, safety: true, keywords: ["brake inspection", "brakes inspected", "brake check"] },
  { key: "air_filter", label: "Air filter", intervalMiles: 30_000, intervalDays: 365, safety: false, keywords: ["air filter"] },
  { key: "tire_inspection", label: "Tire inspection", intervalMiles: null, intervalDays: 30, safety: true, keywords: ["tire inspection", "tires inspected", "tire check", "tread"] },
  { key: "coolant_test", label: "Coolant test", intervalMiles: null, intervalDays: 180, safety: false, keywords: ["coolant"] },
  { key: "belt_hose_inspect", label: "Belts & hoses inspection", intervalMiles: null, intervalDays: 365, safety: false, keywords: ["belt", "hose"] },
  { key: "dot_annual", label: "DOT annual inspection", intervalMiles: null, intervalDays: 365, safety: true, keywords: ["dot annual", "annual inspection", "dot inspection"] },
  { key: "dpf_service", label: "DPF service", intervalMiles: 250_000, intervalDays: null, safety: false, keywords: ["dpf", "diesel particulate"] },
  { key: "trans_diff_fluid", label: "Transmission & differential fluid", intervalMiles: 250_000, intervalDays: null, safety: false, keywords: ["transmission fluid", "differential", "diff fluid", "trans fluid"] },
];

export const MAINTENANCE_TEMPLATE_KEYS = MAINTENANCE_TEMPLATES.map((t) => t.key);

export function templateByKey(key: string | null | undefined): MaintenanceTemplate | null {
  if (!key) return null;
  return MAINTENANCE_TEMPLATES.find((t) => t.key === key) ?? null;
}

/** The honesty label that rides everywhere these numbers appear. */
export const TEMPLATE_HONESTY_LABEL =
  "These intervals are typical manufacturer/fleet starting points - not the carrier's figures and not this truck's manual. Any of them can be changed by telling Abel.";

/**
 * §5.4's fallback: guess a template from a free-text work
 * description ("changed the oil and filters" → engine_oil). The
 * result is ALWAYS presented as a guess in the proposal that uses
 * it; when nothing matches, there is no pairing - never a stretch.
 */
export function guessTemplateKey(description: string): string | null {
  const text = ` ${description.toLowerCase()} `;
  for (const template of MAINTENANCE_TEMPLATES) {
    for (const keyword of template.keywords) {
      if (text.includes(keyword)) return template.key;
    }
  }
  // "oil" alone (e.g. "oil change done") still points at engine oil.
  if (/\boil\b/.test(text)) return "engine_oil";
  return null;
}
