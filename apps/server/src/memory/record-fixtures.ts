import type { LedgerEntry } from "../records/ledger-entry";
import type { Correction, InferredPerson } from "../records/observation";
import { Person } from "../records/truth";
import type { Unit, Verdict } from "../records/unit";
import { type Verdicts, verdictKey } from "./memory-files";

// Records to test the memory steps and the actions with.

export const madeBy = {
  engine: "claude" as const,
  model: "m",
  prompt: "p",
  run: "r1",
};

/** A lifelog unit (a conversation-day about shop repairs, 9 Oct), unless `over` says otherwise. */
export const unit = (over: Partial<Unit> = {}): Unit => ({
  date: "2026-10-09",
  end: "2026-10-09T10:20:00.000Z",
  hash: "0123456789abcdef",
  id: "unit_000000000001",
  key: "conv-1",
  people: [],
  refs: ["conv-1#0-2"],
  schemaVersion: 1,
  source: "lifelog",
  start: "2026-10-09T10:00:00.000Z",
  stats: { chars: 10, fromMe: 0, items: 3 },
  title: "Shop repairs",
  ...over,
});

/** The verdict on `u`'s current content: a importance-2 to-do, unless `over` says otherwise. */
export const verdict = (
  u: Pick<Unit, "hash" | "id">,
  over: Partial<Verdict> = {}
): Verdict => ({
  area: null,
  hash: u.hash,
  importance: 2,
  madeBy,
  reason: "r",
  schemaVersion: 1,
  topics: [],
  type: "to_do",
  unit: u.id,
  when: null,
  ...over,
});

/** Verdicts as the ledger holds them. */
export const ledger = (list: Verdict[]): Verdicts =>
  new Map(list.map((v) => [verdictKey(v.unit, v.hash), v]));

/** An add Life made on his words "write that down in the to-dos", unless `over` says otherwise. */
export const action = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  after: { list: "Travel", title: "Buy checked baggage" },
  at: "2026-10-15T10:00:00.000Z",
  id: "entry_0123456789ab",
  instruction: {
    at: "2026-10-15T09:59:00.000Z",
    quote: "write that down in the to-dos",
    ref: "job-1:3@2026-10-15T09:59:00.000Z",
  },
  kind: "add",
  result: "ok",
  schemaVersion: 1,
  target: "reminder:12",
  via: "session",
  why: "he asked",
  ...over,
});

/** A made-up map: him, his father under a WhatsApp number, a friend, and someone whose alias is another's handle. */
export const people = [
  Person.parse({ aliases: ["Jean"], id: "me", name: "Jean Dupont" }),
  Person.parse({
    aliases: ["Pops"],
    handles: { whatsapp: ["+66600000001"] },
    id: "dad",
    name: "Jean Senior Dupont",
  }),
  Person.parse({ aliases: ["Gas"], id: "gaston", name: "Gaston" }),
  // Owns a handle that is also someone else's alias: the handle must win.
  Person.parse({ aliases: ["+66600000001"], id: "decoy", name: "Decoy" }),
];

/** A person Life inferred, going by `surfaces`. */
export const inferred = (id: string, surfaces: string[], confidence = 0.8) =>
  ({
    area: "shop",
    at: "2026-10-14T00:00:00.000Z",
    confidence,
    evidence: [{ quote: "q", unit: "unit_000000000001" }],
    id,
    madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
    name: "the plumber",
    project: null,
    relation: "plumber",
    schemaVersion: 1,
    surfaces,
  }) as InferredPerson;

/** A correction of his. */
export const said = (c: Record<string, unknown>) =>
  ({ at: "2026-10-14T00:00:00.000Z", schemaVersion: 1, ...c }) as Correction;
