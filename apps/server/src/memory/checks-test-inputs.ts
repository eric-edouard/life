import type { Correction } from "../records/observation";
import { nameGroupsOf } from "./check-sentences";
import type { CheckInputs } from "./checks";
import { guessTestOf } from "./who";

type Input = Partial<Omit<CheckInputs, "people">> & {
  corrections?: Correction[];
  inferred?: string[];
  cards?: { card: string; people: string[] }[];
};

let n = 0;
export const line = (over: Partial<CheckInputs["lines"][number]> = {}) => {
  n += 1;
  return {
    about: undefined,
    confidence: 0.9,
    date: "2026-10-01",
    id: `obs_${String(n).padStart(12, "0")}`,
    quote: "I'll bring it Friday",
    source: { channel: "whatsapp" as const },
    speaker: "unknown:Camille",
    subjects: [],
    text: "He brings it Friday.",
    unit: "unit_000000000001",
    ...over,
  };
};
export const about = (ref: string, over = {}) =>
  line({ subjects: [ref], ...over });

function withoutGroups(
  lines: CheckInputs["lines"],
  over: Input
): Omit<CheckInputs, "nameGroups"> {
  const isGuess = guessTestOf(over.corrections ?? []);
  return {
    answered: new Set(),
    decisions: [],
    dismissed: [],
    doubted: new Set(),
    endings: new Map(),
    heldByAgents: { projects: new Set(), steps: new Set() },
    isDirectionDue: () => false,
    kept: new Set(lines.map((l) => l.id)),
    lines,
    matters: [],
    nameContexts: new Map(),
    paged: new Set(),
    titles: new Map(),
    today: "2026-11-18",
    unresolved: [],
    voices: [],
    where: new Map(),
    ...over,
    people: {
      ambiguousCards: over.cards ?? [],
      candidatesFor: () => [],
      contacts: [],
      inferred: (over.inferred ?? []).map((id) => ({
        at: "2026-10-02T10:00:00.000Z",
        confidence: 0.7,
        evidence: [{ quote: `${id} said hello`, unit: "unit_000000000001" }],
        id,
        name: `Kit ${id}`,
        namesAndHandles: ["+33600000001"],
        relation: "the plumber",
      })),
      isGuess,
      nameOf: (r: string) =>
        r === "person:dana" ? "Dana" : r.replace("unknown:", ""),
      names: new Map(),
      refOf: (r: string) => r,
      relationOf: () => null,
      resolve: (s: string) => (s === DANA_ID ? "person:dana" : null),
    },
  };
}

export const DANA_ID = "00000000-0000-4000-8000-000000000001";

/** A matter's steps, made up: each on 1 Oct with a quote. */
export const stepsOf = (...refs: string[]) =>
  refs.map((ref) => ({ day: "2026-10-01", quote: "it", ref }));

export function inputs(
  lines: CheckInputs["lines"],
  over: Input = {}
): CheckInputs {
  const base = withoutGroups(lines, over);
  return { ...base, nameGroups: nameGroupsOf(base) };
}
