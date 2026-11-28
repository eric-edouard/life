import type { Correction } from "../records/observation";
import type { CheckInputs } from "./check-context";
import { type NameRow, nameGroupsOf } from "./check-sentences";
import type { AgentHold } from "./held-matters";
import { partyOf } from "./party";
import { guessTestOf, latestInUseOf } from "./ref-kinds";

type Input = Partial<Omit<CheckInputs, "people">> & {
  corrections?: Correction[];
  /** The names Life cannot place (`nameGroupsOf`); each spoke in a unit holding his words unless `hisUnitsOf` says. */
  unresolved?: NameRow[];
  hisUnitsOf?: (units: readonly string[]) => ReadonlySet<string>;
  inferred?: string[];
  cards?: { card: string; people: string[] }[];
  /** Person refs folded into another (`refOf`). */
  folds?: Record<string, string>;
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
/** A name Life could not place, said by its own speaker on 1 Oct in a unit of the test (`hasHisWords` decides the exchange). */
export const nameRow = (
  nameAsWritten: string,
  observation: string,
  over: Partial<NameRow> = {}
): NameRow => ({
  date: "2026-10-01",
  nameAsWritten,
  observation,
  unit: "unit_000000000001",
  via: "speaker",
  ...over,
});

export const about = (ref: string, over = {}) =>
  line({ subjects: [ref], ...over });

function withoutGroups(
  lines: CheckInputs["lines"],
  over: Input
): Omit<CheckInputs, "nameGroups"> {
  const isGuess = guessTestOf(
    over.corrections ?? [],
    latestInUseOf((over.inferred ?? []).map((id) => ({ confidence: 0.7, id })))
  );
  const nameOf = (r: string) =>
    r === "person:dana" ? "Dana" : r.replace("unknown:", "");
  const refOf = (r: string) => over.folds?.[r] ?? r;
  return {
    answered: new Set(),
    atOrganizations: [],
    decisions: [],
    deleted: new Set(),
    dismissed: [],
    doubted: new Set(),
    endings: new Map(),
    heldByAgents: [],
    isDirectionDue: () => false,
    isForHandOut: () => false,
    isParked: () => false,
    kept: new Set(lines.map((l) => l.id)),
    lines,
    matters: [],
    nameContexts: new Map(),
    paged: new Set(),
    samePersons: [],
    titles: new Map(),
    today: "2026-11-18",
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
      nameOf,
      names: new Map([["person:dana", "Dana"]]),
      partyOf: partyOf(
        { isOrganization: () => false, nameOf, refOf, relationOf: () => null },
        [],
        () => ({})
      ),
      refOf,
      resolve: (s: string) => (s === DANA_ID ? "person:dana" : null),
    },
  };
}

export const DANA_ID = "00000000-0000-4000-8000-000000000001";

/** A matter's steps, made up: each on 1 Oct with a quote. */
export const stepsOf = (...refs: string[]) =>
  refs.map((ref) => ({
    at: "2026-10-01T09:00:00.000Z",
    day: "2026-10-01",
    quote: "it",
    ref,
  }));

export function inputs(
  lines: CheckInputs["lines"],
  over: Input = {}
): CheckInputs {
  const base = withoutGroups(lines, over);
  return {
    ...base,
    nameGroups: nameGroupsOf({
      ...base,
      hisUnitsOf: over.hisUnitsOf ?? ((units) => new Set(units)),
      people: { ...base.people, corrections: over.corrections ?? [] },
      unresolved: over.unresolved ?? [],
    }),
  };
}

/** One registered agent's hold on `step`: active, asked by him, unless `over` says otherwise (`heldByAgents`' facts). */
export const holdOn = (
  step: string,
  over: Partial<AgentHold> = {}
): AgentHold => ({
  agent: "agt_000000000001",
  closedAt: null,
  openedBy: "owner",
  outcome: null,
  status: "active",
  step,
  whyNotStarted: null,
  ...over,
});

/** An open yes-or-no decision `id`, asked by "planner" until `deadline`, on `subject` when given. */
export const decision = (id: string, deadline: string, subject?: string) => ({
  asker: "planner",
  at: "2026-11-18T09:00:00.000Z",
  context: "",
  deadline,
  drafts: [],
  id,
  kind: "asked" as const,
  links: [],
  onSilence: null,
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  question: `Go ahead with ${id}?`,
  schemaVersion: 3 as const,
  sends: [],
  state: "open" as const,
  ...(subject ? { subject } : {}),
  title: "It is due.",
});
