// Phase F eval — the golden set (fixture arm).
//
// LongMemEval's five abilities, mapped to seeded fixture stores:
// single-fact recall, paraphrase (meaning, not words), Spanish<->
// English crossover, multi-source reasoning, temporal ordering,
// knowledge updates (supersession), and abstention (the answer was
// never stored). Every case names the exact fact(s) that must come
// back — or, for abstention, the answer-shaped markers that must
// NOT appear in anything retrieval returns, because the store does
// not contain them: retrieval that "finds" them is inventing.
//
// Paraphrase/crossover queries are constructed with ZERO content-
// token overlap against their target fact (checked against the
// production tokenSet semantics) — they can only pass through the
// semantic arm, which is the property Phase A exists to provide.

export const COMPANY_ID = "company-eval";

export interface FixtureMemory {
  id: string;
  kind: string;
  content: string;
  created_at: string;
}

export interface FixtureMessage {
  id: string;
  role: string;
  text: string;
  created_at: string;
}

const day = (d: number, hour = 12) => new Date(Date.UTC(2026, 0, d, hour)).toISOString();
const sec = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

const f = (id: string, content: string, created_at: string, kind = "fact"): FixtureMemory => ({
  id,
  kind,
  content,
  created_at,
});

/** Store A — ten everyday facts; shared by the direct-recall cases and every abstention case. */
export const STORE_A: FixtureMemory[] = [
  f("a1", "The truck is a white Freightliner Cascadia", day(1)),
  f("a2", "Steven settles every Friday by direct deposit", day(2)),
  f("a3", "Detention pays fifty dollars an hour after two hours", day(3)),
  f("a4", "The Macon yard gate code is 4417", day(4)),
  f("a5", "Fuel at the Love's in Wildwood is usually cheapest on the route", day(5)),
  f("a6", "The broker for the Atlanta loads is Dana at Meridian Logistics", day(6)),
  f("a7", "Tire pressure on the drives should be 105 psi", day(7)),
  f("a8", "The trailer swap happens at the Jacksonville terminal", day(8)),
  f("a9", "Steven wants a check call every morning by seven", day(9)),
  f("a10", "The reefer unit takes diesel from the small tank", day(10)),
];

/** 250 facts: a unique oldest fact, a unique mid-store fact, and 248 routine fillers. */
export function buildBigStore(): FixtureMemory[] {
  const rows: FixtureMemory[] = [
    f("big-oldest", "The quixotic zebra blanket stays in the cab behind the seat", sec(0)),
  ];
  for (let i = 1; i < 250; i += 1) {
    if (i === 124) {
      rows.push(f("big-mid", "The blue bungee cords hang on the passenger mirror", sec(i)));
    } else {
      rows.push(f(`big-${i}`, `Routine note number ${i} about driving and parking`, sec(i)));
    }
  }
  return rows;
}

export type RecallCategory = "recall" | "paraphrase" | "crossover" | "multi" | "temporal";

export interface RecallCase {
  id: string;
  category: RecallCategory;
  arm: "fallback" | "hybrid";
  store: FixtureMemory[];
  messages?: FixtureMessage[];
  query: string;
  /** Every id must be present in the returned evidence. */
  expectIds: string[];
  /** 1-based rank ceiling applied to each expected id (retrieval cases). */
  maxRank?: number;
  /** First id must rank strictly before the second (temporal cases). */
  orderBefore?: [string, string];
  /** Run through searchMemoryEverywhere instead of context retrieval (multi-source case). */
  viaSearch?: boolean;
  note: string;
}

export const RECALL_CASES: RecallCase[] = [
  // --- single-fact recall, fallback arm (pre-00029 database) ---
  { id: "R-F1", category: "recall", arm: "fallback", store: STORE_A, query: "Steven settles on what day of the week", expectIds: ["a2"], maxRank: 1, note: "settle day, direct words" },
  { id: "R-F2", category: "recall", arm: "fallback", store: STORE_A, query: "what is the gate code for the Macon yard", expectIds: ["a4"], maxRank: 1, note: "gate code" },
  { id: "R-F3", category: "recall", arm: "fallback", store: STORE_A, query: "how much does detention pay per hour", expectIds: ["a3"], maxRank: 1, note: "detention rate" },
  { id: "R-F4", category: "recall", arm: "fallback", store: STORE_A, query: "who is the broker for the Atlanta loads", expectIds: ["a6"], maxRank: 1, note: "broker identity" },
  { id: "R-F5", category: "recall", arm: "fallback", store: STORE_A, query: "what tire pressure for the drives", expectIds: ["a7"], maxRank: 1, note: "tire pressure" },
  { id: "R-F6", category: "recall", arm: "fallback", store: STORE_A, query: "where does the trailer swap happen", expectIds: ["a8"], maxRank: 1, note: "swap location" },
  // --- the old 100-row cliff: oldest + mid-store facts in a 250-fact store, fallback arm ---
  { id: "R-B1", category: "recall", arm: "fallback", store: buildBigStore(), query: "zebra blanket", expectIds: ["big-oldest"], maxRank: 1, note: "oldest of 250 (the dead cliff)" },
  { id: "R-B2", category: "recall", arm: "fallback", store: buildBigStore(), query: "bungee cords mirror", expectIds: ["big-mid"], maxRank: 1, note: "mid-store unique fact" },
  // --- single-fact recall, hybrid arm (00029 RPC contract live) ---
  { id: "R-H1", category: "recall", arm: "hybrid", store: STORE_A, query: "Steven settles Friday deposit", expectIds: ["a2"], maxRank: 1, note: "settle day via hybrid" },
  { id: "R-H2", category: "recall", arm: "hybrid", store: STORE_A, query: "gate code Macon", expectIds: ["a4"], maxRank: 1, note: "gate code via hybrid" },
  { id: "R-H3", category: "recall", arm: "hybrid", store: STORE_A, query: "broker Atlanta Dana", expectIds: ["a6"], maxRank: 1, note: "broker via hybrid" },
  { id: "R-H4", category: "recall", arm: "hybrid", store: STORE_A, query: "morning check call seven", expectIds: ["a9"], maxRank: 1, note: "check call via hybrid" },
  // --- paraphrase: zero shared content tokens with the target; only meaning can find these ---
  {
    id: "P1", category: "paraphrase", arm: "hybrid",
    store: [
      f("p1", "Steven pays for fuel with his company card", day(1)),
      f("p1-f1", "The Jacksonville terminal handles trailer swaps on weekdays", day(2)),
      f("p1-f2", "Dana at Meridian confirms loads by text message", day(3)),
      f("p1-f3", "The sleeper berth has a small fridge for food", day(4)),
    ],
    query: "who covers diesel?", expectIds: ["p1"], maxRank: 1, note: "fuel payer, reworded",
  },
  {
    id: "P2", category: "paraphrase", arm: "hybrid",
    store: [
      f("p2", "Steven pays for fuel with his company card", day(1)),
      f("p2-f1", "The Jacksonville terminal handles trailer swaps on weekdays", day(2)),
      f("p2-f2", "Dana at Meridian confirms loads by text message", day(3)),
      f("p2-f3", "The sleeper berth has a small fridge for food", day(4)),
    ],
    query: "who foots the gas bill?", expectIds: ["p2"], maxRank: 1, note: "fuel payer, slang",
  },
  {
    id: "P3", category: "paraphrase", arm: "hybrid",
    store: [
      f("p3", "Keep the drive tires at one hundred five psi", day(1)),
      f("p3-f1", "The Macon yard opens at six in the morning", day(2)),
      f("p3-f2", "Steven wants the paperwork scanned before noon", day(3)),
      f("p3-f3", "The Atlanta run usually pays well", day(4)),
    ],
    query: "how much air goes in the rubber", expectIds: ["p3"], maxRank: 1, note: "tire pressure, reworded",
  },
  {
    id: "P4", category: "paraphrase", arm: "hybrid",
    store: [
      f("p4", "Detention pays fifty dollars an hour after two hours", day(1)),
      f("p4-f1", "The white Freightliner has a new alternator", day(2)),
      f("p4-f2", "Jacksonville swap point is bay four", day(3)),
      f("p4-f3", "The fridge in the sleeper keeps drinks cold", day(4)),
    ],
    query: "what do I earn sitting at the dock", expectIds: ["p4"], maxRank: 1, note: "detention, reworded",
  },
  {
    id: "P5", category: "paraphrase", arm: "hybrid",
    store: [
      f("p5", "The engine oil gets changed every twenty five thousand miles", day(1)),
      f("p5-f1", "The broker Dana confirms by text", day(2)),
      f("p5-f2", "Steven settles on Fridays", day(3)),
      f("p5-f3", "The yard in Macon has overnight parking", day(4)),
    ],
    query: "how often is the motor lubricant swapped", expectIds: ["p5"], maxRank: 1, note: "oil interval, reworded",
  },
  {
    id: "P6", category: "paraphrase", arm: "hybrid",
    store: [
      f("p6", "The trailer goes back to Jacksonville on Friday nights", day(1)),
      f("p6-f1", "Fuel prices in Wildwood beat Jacksonville most weeks", day(2)),
      f("p6-f2", "The gate code for Macon is 4417", day(3)),
      f("p6-f3", "Detention after two hours pays fifty", day(4)),
    ],
    query: "where does the box end up on weekends", expectIds: ["p6"], maxRank: 1, note: "trailer destination, slang",
  },
  // --- Spanish <-> English crossover (hybrid arm, multilingual meaning) ---
  {
    id: "X1", category: "crossover", arm: "hybrid",
    store: [
      f("x1", "Steven paga el combustible con su tarjeta de la empresa", day(1)),
      f("x1-f1", "The Jacksonville terminal handles trailer swaps", day(2)),
      f("x1-f2", "Dana confirms loads by text message", day(3)),
      f("x1-f3", "The sleeper berth has a small fridge", day(4)),
    ],
    query: "who pays for the diesel?", expectIds: ["x1"], maxRank: 1, note: "fact in Spanish, asked in English",
  },
  {
    id: "X2", category: "crossover", arm: "hybrid",
    store: [
      f("x2", "The reefer runs on diesel from the small tank", day(1)),
      f("x2-f1", "Steven settles every Friday", day(2)),
      f("x2-f2", "The Macon gate code is 4417", day(3)),
      f("x2-f3", "Overnight parking is allowed at the Wildwood yard", day(4)),
    ],
    query: "¿qué combustible usa el remolque refrigerado?", expectIds: ["x2"], maxRank: 1, note: "fact in English, asked in Spanish",
  },
  {
    id: "X3", category: "crossover", arm: "hybrid",
    store: [
      f("x3", "La cita de recogida es el jueves a las ocho", day(1)),
      f("x3-f1", "The truck is a white Freightliner Cascadia", day(2)),
      f("x3-f2", "Fuel in Wildwood is cheapest on Tuesdays", day(3)),
      f("x3-f3", "The broker wants a check call at seven", day(4)),
    ],
    query: "when is the pickup appointment?", expectIds: ["x3"], maxRank: 1, note: "appointment in Spanish, asked in English",
  },
  {
    id: "X4", category: "crossover", arm: "hybrid",
    store: [
      f("x4", "El taller cambia los frenos cada seis meses", day(1)),
      f("x4-f1", "The trailer swap happens in Jacksonville", day(2)),
      f("x4-f2", "The gate code is 4417", day(3)),
      f("x4-f3", "Overnight parking at the yard is free", day(4)),
    ],
    query: "how often does the shop change the brakes?", expectIds: ["x4"], maxRank: 1, note: "brakes in Spanish, asked in English",
  },
  // --- multi-fact + temporal + multi-source ---
  {
    id: "M1", category: "multi", arm: "hybrid", store: STORE_A,
    query: "Steven morning check call settle Friday", expectIds: ["a9", "a2"],
    note: "two facts needed for one answer",
  },
  {
    id: "M2", category: "temporal", arm: "hybrid",
    store: [
      f("m2-old", "In September the Atlanta run paid 2400 dollars", "2026-09-10T12:00:00.000Z"),
      f("m2-new", "In October the Atlanta run paid 2650 dollars", "2026-10-10T12:00:00.000Z"),
      f("m2-f1", "The Macon yard gate code is 4417", day(3)),
      f("m2-f2", "Steven wants a check call every morning", day(4)),
    ],
    query: "what did the Atlanta run pay most recently?", expectIds: ["m2-new", "m2-old"],
    orderBefore: ["m2-new", "m2-old"],
    note: "both values retrieved, newest ranked first",
  },
  {
    id: "M3", category: "multi", arm: "hybrid",
    store: [f("m3a", "The broker for the Atlanta loads is Dana at Meridian Logistics", day(1))],
    messages: [
      { id: "m3-msg1", role: "user", text: "Dana said detention is on them after two hours", created_at: day(2) },
      { id: "m3-msg2", role: "user", text: "Traffic on I-75 was awful today", created_at: day(3) },
    ],
    query: "Atlanta broker detention", expectIds: ["m3a", "m3-msg1"], viaSearch: true,
    note: "evidence spans a memory and a past conversation",
  },
];

export interface UpdateCase {
  id: string;
  arm: "hybrid" | "fallback";
  /** Seed store holding the OLD row as current. */
  seed: FixtureMemory[];
  oldId: string;
  /** The write that lands through the real store path (createBotStore.saveMemory). */
  save: { kind: string; content: string; supersedesId?: string };
  query: string;
  /** Must appear in CURRENT retrieval after the write. */
  newMarker: string;
  /** Must NOT appear in current retrieval after the write (it is history now). */
  oldMarker: string;
  /** Also assert the old row is still findable through history search. */
  checkHistory?: boolean;
  historyQuery?: string;
  note: string;
}

export const UPDATE_CASES: UpdateCase[] = [
  {
    id: "U1", arm: "hybrid",
    seed: [f("u1-old", "BUSINESS — Settlement day | Steven settles on Fridays.", day(1), "business_fact")],
    oldId: "u1-old",
    save: { kind: "business_fact", content: "BUSINESS — Settlement day | Steven settles on Thursdays." },
    query: "when does Steven settle",
    newMarker: "Thursdays", oldMarker: "Fridays",
    checkHistory: true, historyQuery: "Steven settles Fridays",
    note: "business fact superseded; old value is history, not current",
  },
  {
    id: "U2", arm: "hybrid",
    seed: [f("u2-old", "PERSON — Steven | role: truck owner | Pays on Fridays.", day(1), "person_profile")],
    oldId: "u2-old",
    save: { kind: "person_profile", content: "PERSON — Steven | role: truck owner | Pays on Thursdays." },
    query: "Steven truck owner pay day",
    newMarker: "Thursdays", oldMarker: "Fridays",
    note: "person profile superseded (name + role confirmed)",
  },
  {
    id: "U3", arm: "fallback",
    seed: [f("u3-old", "BUSINESS — Fuel | Steven pays for fuel on his card.", day(1), "business_fact")],
    oldId: "u3-old",
    save: { kind: "business_fact", content: "BUSINESS — Fuel | The driver pays for fuel and gets reimbursed weekly." },
    query: "who pays for fuel",
    newMarker: "reimbursed", oldMarker: "on his card",
    note: "supersession holds on the fallback arm too",
  },
  {
    id: "U4", arm: "hybrid",
    seed: [f("u4-old", "The gate code at the Macon yard is 4417", day(1))],
    oldId: "u4-old",
    save: { kind: "fact", content: "The gate code at the Macon yard is 9031", supersedesId: "u4-old" },
    query: "Macon yard gate code",
    newMarker: "9031", oldMarker: "4417",
    note: "plain fact updated via an explicitly named row",
  },
];

export interface AbstentionCase {
  id: string;
  arm: "hybrid" | "fallback";
  query: string;
  /** Answer-shaped substrings that exist NOWHERE in Store A — retrieval returning them is invention. */
  absentMarkers: string[];
  note: string;
}

/** Asked against Store A. Several are near-misses: a similar fact IS stored, but it does not answer this question. */
export const ABSTENTION_CASES: AbstentionCase[] = [
  { id: "A01", arm: "hybrid", query: "what is the truck's license plate number?", absentMarkers: ["license plate", "plate number"], note: "never stored" },
  { id: "A02", arm: "fallback", query: "how much does Steven charge for lumper fees?", absentMarkers: ["lumper"], note: "never stored" },
  { id: "A03", arm: "hybrid", query: "what day is the carrier's safety meeting?", absentMarkers: ["safety"], note: "never stored" },
  { id: "A04", arm: "fallback", query: "what is Dana's phone number?", absentMarkers: ["phone", "555"], note: "near-miss: Dana is stored, her number is not" },
  { id: "A05", arm: "hybrid", query: "how many miles is it to the Atlanta delivery?", absentMarkers: ["miles"], note: "never stored" },
  { id: "A06", arm: "fallback", query: "what does the Jacksonville terminal charge for storage?", absentMarkers: ["storage"], note: "near-miss: the terminal is stored, storage pricing is not" },
  { id: "A07", arm: "hybrid", query: "when does the truck insurance expire?", absentMarkers: ["insurance"], note: "never stored" },
  { id: "A08", arm: "fallback", query: "what hotel does Steven book for layovers?", absentMarkers: ["hotel"], note: "never stored" },
  { id: "A09", arm: "hybrid", query: "¿cuánto paga el flete de Miami?", absentMarkers: ["miami", "flete"], note: "never stored, asked in Spanish" },
  { id: "A10", arm: "fallback", query: "what temperature should the reefer be set to?", absentMarkers: ["temperature", "degrees"], note: "near-miss: the reefer is stored, its setting is not" },
  { id: "A11", arm: "hybrid", query: "who is the dispatcher for night loads?", absentMarkers: ["dispatcher"], note: "near-miss: a broker is stored, no dispatcher" },
  { id: "A12", arm: "fallback", query: "what time does the Macon yard gate open?", absentMarkers: ["opens"], note: "near-miss: the gate code is stored, hours are not" },
  { id: "A13", arm: "hybrid", query: "how much is the toll on the Florida turnpike?", absentMarkers: ["toll", "turnpike"], note: "never stored" },
  { id: "A14", arm: "fallback", query: "what is the wifi password at the Jacksonville terminal?", absentMarkers: ["wifi", "password"], note: "never stored" },
  { id: "A15", arm: "hybrid", query: "when is the truck's DOT inspection due?", absentMarkers: ["inspection"], note: "never stored" },
  { id: "A16", arm: "fallback", query: "what did the broker offer for the Tampa load?", absentMarkers: ["tampa"], note: "near-miss: an Atlanta broker is stored, no Tampa offer" },
  { id: "A17", arm: "hybrid", query: "how many gallons does the small tank hold?", absentMarkers: ["gallon"], note: "near-miss: the small tank is stored, its capacity is not" },
  { id: "A18", arm: "fallback", query: "what is Steven's home address?", absentMarkers: ["address", "street"], note: "never stored" },
  { id: "A19", arm: "hybrid", query: "¿cuál es el código del patio de Atlanta?", absentMarkers: ["patio"], note: "near-miss in Spanish: Atlanta is stored, no yard code for it" },
  { id: "A20", arm: "fallback", query: "what year is the trailer?", absentMarkers: ["year"], note: "near-miss: the trailer is stored, its year is not" },
];
