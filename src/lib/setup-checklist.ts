// First-run setup checklist (ChatGPT audit rank 9): what is configured is DETECTED from the owner's real records, never ticked by
// hand, so it cannot say "done" about something that is not. Essential items gate honest pay figures; optional ones improve
// planning. Pure - the component supplies the facts.

export interface SetupFacts {
  payProfiles: { rate_cents_per_mile: number; percent_of_load_bps?: number | null; mile_basis: string | null; pay_week_ends_on?: number | null; payday_weekday?: number | null; effective_to: string | null }[];
  truckCount: number;
  truckWithProfileCount: number;
  loadCount: number;
  driverCount: number;
  /** True when the HOS carrier settings still equal the app's placeholder defaults; null/undefined = unknown (the item is then left out). */
  hosProvisional?: boolean | null;
}

export interface SetupItem {
  key: string;
  label: string;
  why: string;
  href: string;
  essential: boolean;
  done: boolean;
}

export function buildSetupChecklist(f: SetupFacts): SetupItem[] {
  const current = f.payProfiles.filter((p) => !p.effective_to);
  const hasTerms = current.some((p) => p.rate_cents_per_mile > 0 || (p.percent_of_load_bps ?? 0) > 0);
  return [
    { key: "pay-terms", label: "Enter your pay terms", why: "Every pay figure (projected pay, paychecks, advances) is priced from them.", href: "/more/settings/pay", essential: true, done: hasTerms },
    { key: "miles-basis", label: "Say which miles you are paid on", why: "Until it is set, per-mile pay shows a range instead of one number.", href: "/more/settings/pay", essential: true, done: hasTerms && current.some((p) => p.mile_basis !== null) },
    { key: "pay-week", label: "Set your pay week and payday", why: "Groups your loads and advances under the right payday.", href: "/more/settings/pay", essential: true, done: current.some((p) => p.pay_week_ends_on != null && p.payday_weekday != null) },
    { key: "truck", label: "Add your truck", why: "Hours, maintenance, fuel and routes attach to a truck.", href: "/fleet/trucks/new", essential: true, done: f.truckCount > 0 },
    { key: "first-load", label: "Add your first load", why: "Loads are what pay, hours and the paycheck check are built on.", href: "/loads/new", essential: true, done: f.loadCount > 0 },
    { key: "truck-profile", label: "Fill in your truck profile (height, length, weight)", why: "Smart Path plans legal, truck-safe routes from it.", href: "/fleet/truck-profile", essential: false, done: f.truckCount > 0 && f.truckWithProfileCount > 0 },
    ...(f.hosProvisional == null
      ? []
      : [{ key: "hos-rules", label: "Confirm your carrier's hours-of-service rules", why: "Your cycle, period start and time zone still match the app's placeholder values, so the clocks are provisional until you confirm or change them.", href: "/more/settings", essential: false, done: !f.hosProvisional }]),
    { key: "driver", label: "Add yourself as a driver", why: "Lets advances and loads be assigned to a driver.", href: "/fleet/drivers/new", essential: false, done: f.driverCount > 0 },
  ];
}

export const essentialRemaining = (items: SetupItem[]): number => items.filter((i) => i.essential && !i.done).length;
export const allDone = (items: SetupItem[]): boolean => items.every((i) => i.done);
