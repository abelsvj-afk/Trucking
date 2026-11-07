// A small, curated, code-reviewed set of general guidance for situations every kind of driver runs into (owner
// 2026-11-07; docs/design/fleet-learning-and-driver-questions.md section 6). Deliberately NOT a model answer: the text
// below is fixed, reviewed and free of anything that changes by year - no dollar amounts, rates, fines or tax limits
// (those must come from the owner's own stored values). The few federal hours-of-service limits mentioned are the same
// rules the app's own clocks use. General information only, not legal, tax or safety advice.

export interface Reference {
  title: string;
  steps: string[];
  /** Words that should find this topic. */
  keywords: string[];
}

export const FOOTER = "General guidance, not legal, tax or safety advice - follow your carrier's policies and the law where you are.";

export const REFERENCES: Record<string, Reference> = {
  breakdown: {
    title: "🛠️ Broke down",
    keywords: ["breakdown", "broke down", "flat tire", "blowout", "won't start", "engine", "stalled", "stranded", "tow"],
    steps: [
      "Get safely off the travel lanes if you can, put the hazard flashers on, and set out your reflective triangles or flares the way your carrier and the rules require.",
      "Call dispatch or the owner, then your roadside-assistance number. Give the exact location (mile marker, direction, nearest exit).",
      "Photograph the problem and the surroundings before anything is moved. Keep every receipt.",
      "Log it correctly: you are on duty, not driving. Tell me and I will record the maintenance event and any defect.",
      "If the load is time-sensitive, tell the broker or receiver early - an early call protects the relationship and any detention or late-fee argument.",
    ],
  },
  accident: {
    title: "🚨 Accident",
    keywords: ["accident", "crash", "collision", "wreck", "hit", "someone hit me"],
    steps: [
      "Check yourself and others first. Call 911 if anyone may be hurt or the road is blocked.",
      "Stay at the scene. Turn on the hazard flashers and protect the scene with your warning devices if it is safe to.",
      "Do not argue about fault or sign anything except for the police. Be factual and calm.",
      "Exchange names, plates, insurance and contact details. Get the officer's name and the report number.",
      "Photograph everything: all vehicles, plates, damage, the road, signs, the weather, and the cargo.",
      "Call your carrier or owner right away, then the insurance claims line. Your carrier will tell you about any post-accident testing and its timing - ask before you do anything that could affect it.",
    ],
  },
  roadside_inspection: {
    title: "🛑 Roadside inspection",
    keywords: ["inspection", "dot", "weigh station", "scale", "pulled over", "officer", "inspector"],
    steps: [
      "Pull over where the officer directs, stay calm and polite, and keep your hands visible.",
      "Have these ready: CDL, medical card, registration, proof of insurance, your logs (or the ELD output), the bill of lading, and the permit/IFTA credentials your carrier uses.",
      "Answer what is asked; do not volunteer extra. You may ask for a moment to find a document.",
      "Walk around with the inspector if asked. Know your truck: lights, tires, brakes, and your pre-trip record.",
      "Always get a copy of the inspection report. Photograph it and send it to your carrier or owner; tell me and I will file it.",
      "If the truck is placed out of service, do not drive it until the violation is cleared and the carrier says so.",
    ],
  },
  lost_bol: {
    title: "📄 Lost or missing paperwork (BOL / POD)",
    keywords: ["lost bol", "missing bol", "no bol", "bol", "pod", "paperwork", "bill of lading", "rate con"],
    steps: [
      "Call the shipper or receiver and ask them to email a copy now. Ask the broker too.",
      "Take clear photos of whatever you do have, including the seal number and any notes you wrote.",
      "Do not leave a receiver without a signed, dated proof of delivery.",
      "Send me the photos and I will file them against the load so they are easy to find at settlement time.",
    ],
  },
  detention: {
    title: "⏱️ Waiting at a dock (detention)",
    keywords: ["detention", "waiting", "dock", "holding me", "long wait", "layover"],
    steps: [
      "Check your rate confirmation: it states the free time and the detention rate. Detention only bills after the free time.",
      "Note your arrival time and the time you were actually loaded or unloaded - tell me and I will stamp them so there is a record.",
      "Tell the broker in writing (text or email) when detention starts, not after the fact.",
      "Keep the signed in/out times from the facility. Those support the invoice.",
    ],
  },
  hos_overview: {
    title: "🕒 Hours of service in a nutshell",
    keywords: ["hours of service", "hos", "11 hour", "14 hour", "cycle", "restart", "34 hour", "30 minute break", "how many hours"],
    steps: [
      "These are the federal rules for property-carrying drivers; the clocks in the app use them. Exceptions exist, and your carrier's policy may be stricter.",
      "11 hours of driving is allowed after 10 consecutive hours off duty.",
      "The 14-hour window starts when you come on duty after that break; driving cannot happen after it ends, even if you have drive time left.",
      "A 30-minute break is required once you have driven 8 hours without one.",
      "The 60/70-hour cycle limits on-duty time over 7 or 8 days; a 34-hour restart resets it.",
      "Ask me 'how many hours do I have' and I read your actual clocks instead of this summary.",
    ],
  },
  eld_malfunction: {
    title: "📟 Logging device problem",
    keywords: ["eld", "log device", "malfunction", "logging device", "paper log", "logs down"],
    steps: [
      "Write down when the problem started, and keep recording your duty status on paper from that moment.",
      "Tell your carrier promptly - the rules give short deadlines for reporting and for fixing a malfunction.",
      "Be ready to reconstruct your recent duty status on paper. Keep blank paper logs in the truck.",
      "This app is a paper-log helper, not a registered ELD: it does not replace the device your carrier requires.",
    ],
  },
  cargo_damage: {
    title: "📦 Cargo damage or shortage",
    keywords: ["damage", "damaged", "shortage", "short", "claim", "cargo claim", "refused load", "reefer temp"],
    steps: [
      "Before signing, write the damage or shortage on the bill of lading, and photograph it with the seal and the load position.",
      "For temperature-controlled freight, keep the temperature records and the reefer settings you were given.",
      "Tell your carrier or broker right away; do not wait until delivery paperwork is closed.",
      "Keep everything - photos, the BOL, texts. Tell me and I will file it with the load.",
    ],
  },
  overweight: {
    title: "⚖️ Overweight or axle problem at the scale",
    keywords: ["overweight", "over weight", "axle", "scale ticket", "gross weight", "heavy"],
    steps: [
      "Legal weight limits apply to the total and to each axle group, and they depend on the state. Check your scale ticket against the limits where you are.",
      "Sliding the tandems or shifting the load can fix an axle problem without changing the total.",
      "Do not keep driving overweight. Call dispatch or the shipper to correct it.",
      "Keep the scale ticket and tell me so I can file it with the load.",
    ],
  },
  fatigue: {
    title: "😴 Too tired to drive",
    keywords: ["tired", "sleepy", "drowsy", "fatigue", "can't stay awake", "exhausted"],
    steps: [
      "Stop. No load, appointment or deadline is worth driving drowsy. Get to a safe place and rest.",
      "Your hours clocks measure the rules, not how alert you are - you can be legal and still too tired.",
      "Tell dispatch or the owner you need to rest; a late call is far better than a crash.",
      "If you need help finding the next stop, ask me to check the route.",
    ],
  },
  deductions_overview: {
    title: "🧾 What owner-operators and lease-ons commonly track for taxes",
    keywords: ["deduct", "deduction", "write off", "tax", "taxes", "expenses i can", "per diem"],
    steps: [
      "Categories drivers and small carriers commonly track: fuel, repairs and maintenance, tires, tolls, scales, permits and licenses, insurance, truck or lease payments, parking, and communication.",
      "Keep a receipt or photo for every expense and record the date, amount and what it was for - I will keep those if you send them.",
      "Per diem and similar rules depend on your tax status and are set each year; I will not quote a number from memory. If you give me the current figure I can count your days away from home.",
      "Employees, lease-ons and owner-operators are treated differently. Rules change - confirm what applies to you with a tax professional.",
    ],
  },
  emergency_contacts: {
    title: "📇 Numbers every driver should have saved",
    keywords: ["emergency contact", "who do i call", "numbers", "contacts", "roadside", "claims line"],
    steps: [
      "Dispatch and the owner, 24 hours a day.",
      "The insurance claims line and the policy number.",
      "Your roadside-assistance provider and its membership number.",
      "The carrier's safety or compliance contact.",
      "For each broker you run with: an after-hours number.",
      "Tell me these and I will remember them, so you can ask 'who do I call for a tow' and get the answer.",
    ],
  },
  settlement_check: {
    title: "💵 Checking a settlement",
    keywords: ["settlement", "short", "paycheck wrong", "pay is wrong", "deductions", "escrow", "advance"],
    steps: [
      "Compare each load's pay with what your terms say it should be: miles times your per-mile rate, or your percent of the load, plus anything added.",
      "Check every deduction line: fuel advances, escrow, insurance, lease or truck payments, and fees. Each should match something you agreed to.",
      "The Paychecks page shows what each finished load should have paid against what landed - start there.",
      "If a number is wrong, ask the carrier for the line-item detail in writing before disputing it.",
    ],
  },
};

/** The topic keys, for the tool schema. */
export const REFERENCE_TOPICS = Object.keys(REFERENCES);

/** Finds the best topic for free text (exact key first, then keyword hits). */
export function findReference(query: string): string | null {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return null;
  if (q in REFERENCES) return q;
  const normalized = q.replace(/[\s-]+/g, "_");
  if (normalized in REFERENCES) return normalized;
  let best: { key: string; score: number } | null = null;
  for (const [key, ref] of Object.entries(REFERENCES)) {
    // whole words/phrases only, so "bol" matches "my BOL" but never "symbol"
    const score = ref.keywords.reduce((s, k) => s + (new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(q) ? k.length : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { key, score };
  }
  return best?.key ?? null;
}

export function formatReference(key: string): string {
  const r = REFERENCES[key]!;
  return `${r.title}\n${r.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n${FOOTER}`;
}
