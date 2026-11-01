// Abel Job Brain (docs/design/driver-mvp.md §11). The job-knowledge
// module: what the assistant coaches FROM when the owner asks how
// to handle the work - the load lifecycle, the paperwork, facility
// problems, and how driver pay is actually structured. Static,
// curated content (not live data): every figure in here is a labeled
// estimate with an as-of date, and the pay bands are the SAME
// constants the pay advisor tool grades against, so the coaching
// and the math can never drift apart.
//
// The owner this serves is a new-CDL driver running an
// owner-operator's second truck, leased on to a carrier - the bands
// and examples are written for that seat, not for a mega-carrier
// trainee and not for an owner-operator.

export const JOB_KNOWLEDGE_AS_OF = "2026-10-31";

/**
 * Market bands for a new-CDL driver in an owner-operator's second
 * truck (regional/OTR), as of the date above. ESTIMATES for
 * orientation - what a fair offer looks like in this seat - not
 * quotes and not live market data.
 */
export const PAY_BANDS = {
  asOf: JOB_KNOWLEDGE_AS_OF,
  /** Gross pay for a full working week in this seat. */
  weeklyGrossDollars: { weakBelow: 1000, strongAbove: 1500 },
  /** Effective cents-per-mile computed on ALL miles (loaded + empty). */
  effectiveCpmAllMiles: { weakBelow: 0.55, strongAbove: 0.65 },
  /** Driver's percentage of the gross linehaul (owner-op's truck, owner pays fuel). */
  percentageOfGross: { weakBelow: 22, fairFrom: 25, strongAbove: 30 },
  note: "Bands are estimates (Oct 2026) for a new-CDL driver in an owner-operator's second truck; the owner's own target zone is $1,200-$1,500 gross per full week.",
} as const;

export const LOAD_LIFECYCLE: string[] = [
  "Offer: a load is offered (by the carrier's dispatch or a broker) with lane, rate, pickup/delivery windows. Nothing is real until the rate confirmation exists.",
  "Rate confirmation (rate con): the written contract for the load - lane, rate, dates/times, commodity, weight, accessorials. Read it before rolling; what is not in it does not exist.",
  "Deadhead: driving empty to the shipper. Whether deadhead miles are paid is a pay-structure question - know yours before you roll.",
  "Check-in at the shipper: guard/driver check-in, door assignment, live load or drop. Start your detention clock the moment you arrive - note the time.",
  "Loaded + BOL: count/condition noted, seal applied if required. The bill of lading is signed at pickup - what you sign for is what you're liable for.",
  "Transit: HOS clocks run; weigh stations and scale checks; fuel per the truck's plan. Report problems (breakdown, delay) to dispatch EARLY, not at the appointment time.",
  "Receiver: check in, detention clock again, unloading (lumper services are common for groceries - fees are normally billed through, get the receipt).",
  "POD: a clean signed proof of delivery - signed, printed name, date/time, exceptions noted. Photograph it before you hand over the only copy.",
  "Paperwork in: BOL/POD, scale tickets, lumper receipts go to the carrier/broker the way they require - a load isn't payable until the paperwork is in.",
  "Settlement: the load appears on a settlement statement with every deduction itemized. Check each line against the rate con while the run is fresh in memory.",
];

export interface PaperworkGuide {
  document: string;
  whatItIs: string;
  checkBeforeSigning: string[];
  photograph: string;
  pitfalls: string[];
}

export const PAPERWORK_GUIDES: PaperworkGuide[] = [
  {
    document: "Bill of lading (BOL)",
    whatItIs:
      "The load's legal receipt and contract of carriage: shipper, receiver, commodity, piece count, weight, and any seal number. You sign it at pickup (accepting the freight as described) and the receiver signs it at delivery (the POD).",
    checkBeforeSigning: [
      "Addresses and load/reference numbers match the rate con.",
      "Piece count and description match what was actually loaded - if you couldn't count it, 'shipper load and count' should be on it.",
      "Seal number on the BOL matches the physical seal digit for digit.",
      "Damage or shortage visible at loading is noted on the BOL BEFORE you sign - never sign 'clean' for damaged freight.",
    ],
    photograph: "Every page, every time, at pickup AND the signed copy at delivery, before handing over the original.",
    pitfalls: [
      "Signing for a count you never saw without the shipper-load-and-count notation.",
      "Leaving the shipper with a seal number that doesn't match the paperwork - it becomes your problem at the receiver.",
    ],
  },
  {
    document: "Rate confirmation (rate con)",
    whatItIs:
      "The written agreement for the load: who pays what - linehaul rate, fuel surcharge, and any detention/layover/accessorial terms. If a pay term isn't on the rate con, it effectively doesn't exist.",
    checkBeforeSigning: [
      "Rate and what it includes (linehaul only, or linehaul + surcharge).",
      "Pickup/delivery addresses, dates, and appointment times.",
      "Detention terms: free time and the per-hour rate after it.",
      "Anything about lumper fees, driver unload, or pallet exchange.",
      "For percentage pay: whether your percentage is of gross linehaul or of a net figure, and what's deducted first.",
    ],
    photograph: "The whole document, all pages, before you accept the load - keep it with the load in the app.",
    pitfalls: [
      "Agreeing to terms on a phone call that never made it onto the rate con.",
      "A percentage quoted on 'net' without the deductions spelled out - net can be made to mean almost anything.",
    ],
  },
  {
    document: "Scale ticket",
    whatItIs:
      "The certified weight record (steer/drive/trailer/gross) from a scale - proof the load is legal (80,000 lb gross federal cap) and the record if a weight dispute or ticket happens.",
    checkBeforeSigning: [
      "Gross weight legal, and axle weights legal - slide tandems or shift the load before rolling heavy.",
      "Ticket shows the truck/trailer and date/time that match this load.",
    ],
    photograph: "Every ticket, even legal ones - an overweight ticket defense lives or dies on paperwork.",
    pitfalls: [
      "Rolling on a shipper's 'it's about 42,000' instead of weighing - the ticket is issued to the driver, not the shipper.",
    ],
  },
  {
    document: "Lumper receipt",
    whatItIs:
      "Receipt for unloading services at a receiver (common at grocery warehouses). The fee is normally the carrier/broker's cost, billed through with the receipt - no receipt, no reimbursement.",
    checkBeforeSigning: [
      "Amount, facility, date, and the load/reference number are on it.",
      "Who pays was settled BEFORE you pay out of pocket - ask dispatch first if it's not already agreed.",
    ],
    photograph: "The receipt the moment you get it; it is the reimbursement claim.",
    pitfalls: [
      "Paying cash with no receipt - that money is gone.",
      "Assuming a lumper fee comes out of your percentage - it should be billed through or reimbursed, per the rate con.",
    ],
  },
  {
    document: "Settlement statement",
    whatItIs:
      "The pay record: every load in the period, its gross, your share, and every deduction itemized (fuel, insurance, escrow, dispatch fees on lease-on arrangements). This is where your pay is proven or lost.",
    checkBeforeSigning: [
      "Every load you ran appears, at the rate on its rate con.",
      "Every deduction is one you agreed to, at the agreed amount - question anything new in writing.",
      "Escrow balances and what they're for; escrow is your money held, not a fee.",
    ],
    photograph: "Every statement, kept permanently - settlements are the business's memory and your tax records.",
    pitfalls: [
      "Not checking while the runs are fresh - discrepancies you catch a month later are nearly impossible to unwind.",
      "Treating a deduction as normal because it appeared twice - ask the first time.",
    ],
  },
];

export interface FacilityProblemGuide {
  situation: string;
  doFirst: string[];
  say: string;
  neverDo: string;
}

export const FACILITY_PROBLEM_GUIDES: FacilityProblemGuide[] = [
  {
    situation: "Detention (waiting past your appointment to load/unload)",
    doFirst: [
      "Note your arrival time the moment you check in - on the BOL and in the app.",
      "Tell dispatch you're waiting BEFORE the free time runs out, not after.",
      "Get in/out times stamped or signed on the paperwork when you leave.",
    ],
    say: "I checked in at [time], still waiting on a door as of [time]. Can you note the detention on this load?",
    neverDo: "Don't leave without telling dispatch, and don't accept 'we'll take care of you' - detention that isn't on the paperwork isn't paid.",
  },
  {
    situation: "Refused freight (receiver won't take some or all of it)",
    doFirst: [
      "Stay put and call dispatch/your carrier contact before doing anything else.",
      "Get the refusal reason and who refused it, in writing or noted on the BOL by the receiver.",
      "Photograph the freight and the paperwork exactly as they are.",
    ],
    say: "I have a refusal on [count] pieces - reason given is [reason]. I'm holding here until you tell me where this freight goes.",
    neverDo: "Don't dump, donate, or re-deliver refused freight anywhere on your own call - where it goes is the carrier/broker's decision, in writing.",
  },
  {
    situation: "Seal mismatch or broken seal",
    doFirst: [
      "Stop. Do not open the doors or accept/sign until dispatch knows.",
      "Photograph the seal, its number, and the BOL side by side.",
      "Note 'seal mismatch on arrival, number X vs paperwork Y' on the BOL before anyone signs.",
    ],
    say: "The seal on the trailer is [number], the paperwork says [number]. I haven't opened it - how do you want this handled?",
    neverDo: "Never break a seal or sign a clean receipt over a mismatch silently - a quiet signature makes the shortage yours.",
  },
  {
    situation: "Lumper fee demanded at the dock",
    doFirst: [
      "Ask the amount and get it in writing before paying anything.",
      "Check the rate con / ask dispatch who pays - it's normally billed through to the broker/carrier.",
      "Pay only the agreed way (Comchek/EFS/cash) and get the receipt with the load number on it.",
    ],
    say: "The lumper fee here is $[amount]. Is that billed through, or do you want me to pay and send the receipt?",
    neverDo: "Don't pay cash without a receipt, and don't let a lumper fee quietly come out of your own percentage.",
  },
  {
    situation: "Running late for an appointment",
    doFirst: [
      "Call as soon as you KNOW you'll be late - hours early beats one minute after.",
      "Give an honest ETA based on your clocks (the ELD governs, not hope).",
      "Note the new appointment time and who gave it, and get it in the thread in writing.",
    ],
    say: "I'm going to miss the [time] appointment - my honest ETA is [time] based on my hours. Can we move it, and can you confirm the new time here?",
    neverDo: "Don't just show up late hoping - a no-call late arrival can mean a refused load and a service failure on your record.",
  },
];

export const PAY_STRUCTURE_GUIDE: string[] = [
  "CPM, loaded miles only: you're paid per mile ONLY when loaded. Empty (deadhead) miles are unpaid - a 60¢ loaded-only offer with 20% empty miles is really 48¢ on all miles. Always convert offers to effective CPM on ALL miles before comparing.",
  "CPM, all miles: paid loaded and empty. Simpler and usually fairer for the driver; the standard in this seat is roughly the PAY_BANDS range on all miles.",
  "Percentage of gross linehaul: you get a cut (fair band in PAY_BANDS) of what the load pays the truck. Ask: gross of WHAT - linehaul only, or linehaul + fuel surcharge? And can you see the rate con for every load (you should - your pay is computed from it).",
  "Percentage of net: your cut is taken AFTER deductions. Net is only fair if the deductions are named, capped, and visible on the settlement - fuel, insurance, dispatch fees can quietly eat a 'high' percentage down below a modest gross percentage.",
  "Flat per load / per day: predictable, but check it against the load's miles and days - a flat that looks fine on a 300-mile one-day load is weak on a 900-mile three-day load. Convert to effective CPM and a weekly figure before judging it.",
  "Accessorials are real money: detention (after a free window, usually 2 hours), layover pay for a day lost, deadhead pay, breakdown pay. An offer with strong accessorials can beat a 'higher' base offer that has none - ask for each one explicitly.",
  "Who pays what: in this seat the TRUCK OWNER normally pays fuel, tolls, scales, insurance, and maintenance - it's his truck. If any of those land on the driver, the pay must be visibly higher to compensate; fuel alone runs hundreds per load.",
  "W2 vs 1099: as a W2 employee the employer pays half the payroll tax (7.65% employer FICA) and you get workers' comp and unemployment coverage. As a 1099 contractor you pay BOTH halves - self-employment tax is 15.3% on 92.35% of your net earnings (≈14.1% effective) - and you lose those protections. On taxes alone a 1099 offer must pay about 8% more than a W2 offer to break even; with the lost protections, demand roughly 20% more before calling it equal.",
  "Pay timing is a term, not a detail: weekly vs per-settlement, how many days after delivery, and what happens to your last settlements if you leave. Get it in writing like every other term.",
];

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * The knowledge rendered for prompt injection - condensed but
 * complete on the coaching-critical parts. The structured exports
 * above stay the source of truth (the pay advisor grades against
 * PAY_BANDS directly); this string is assembled FROM them so the
 * two can never disagree.
 */
export function renderJobKnowledgeBrief(): string {
  const bands = PAY_BANDS;
  const parts: string[] = [
    `JOB KNOWLEDGE (curated, as of ${JOB_KNOWLEDGE_AS_OF} - coach from this; figures are labeled estimates, not live data):`,
    "",
    "THE LOAD LIFECYCLE:",
    bulletList(LOAD_LIFECYCLE),
    "",
    "PAPERWORK - WHAT IT IS, WHAT TO CHECK BEFORE SIGNING:",
    ...PAPERWORK_GUIDES.map(
      (guide) =>
        `- ${guide.document}: ${guide.whatItIs} CHECK: ${guide.checkBeforeSigning.join(" ")} PHOTOGRAPH: ${guide.photograph} WATCH OUT: ${guide.pitfalls.join(" ")}`,
    ),
    "",
    "FACILITY PROBLEMS - WHAT TO DO AND SAY:",
    ...FACILITY_PROBLEM_GUIDES.map(
      (guide) =>
        `- ${guide.situation}: DO: ${guide.doFirst.join(" ")} SAY: "${guide.say}" NEVER: ${guide.neverDo}`,
    ),
    "",
    "HOW DRIVER PAY WORKS:",
    bulletList(PAY_STRUCTURE_GUIDE),
    "",
    `PAY BANDS (estimates, ${bands.asOf}, new-CDL driver in an owner-operator's second truck): weekly gross under $${bands.weeklyGrossDollars.weakBelow} is weak, over $${bands.weeklyGrossDollars.strongAbove} is strong; effective CPM on ALL miles under $${bands.effectiveCpmAllMiles.weakBelow.toFixed(2)} is weak, over $${bands.effectiveCpmAllMiles.strongAbove.toFixed(2)} is strong; a percentage of gross linehaul under ${bands.percentageOfGross.weakBelow}% is weak, ${bands.percentageOfGross.fairFrom}-${bands.percentageOfGross.strongAbove}% is the fair band. ${bands.note}`,
  ];
  return parts.join("\n");
}

export const JOB_KNOWLEDGE_BRIEF = renderJobKnowledgeBrief();
