import type { Action } from "../records/ledger-entry";
import type { Unit, Verdict } from "../records/unit";
import { type Verdicts, verdictKey } from "./ledger";

// Records to test the memory steps and the actions with.

export const madeBy = {
  engine: "claude" as const,
  model: "m",
  prompt: "p",
  run: "r1",
};

/** A lifelog unit (a chapter about shop repairs, 9 Oct), unless `over` says otherwise. */
export const unit = (over: Partial<Unit> = {}): Unit => ({
  date: "2026-10-09",
  end: "2026-10-09T10:20:00.000Z",
  hash: "0123456789abcdef",
  id: "u_000000000001",
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

/** The verdict on `u`'s current content: a salience-2 to-do, unless `over` says otherwise. */
export const verdict = (
  u: Pick<Unit, "hash" | "id">,
  over: Partial<Verdict> = {}
): Verdict => ({
  area: null,
  hash: u.hash,
  madeBy,
  reason: "r",
  salience: 2,
  schemaVersion: 1,
  topics: [],
  type: "todo",
  unit: u.id,
  when: null,
  ...over,
});

/** Verdicts as the ledger holds them. */
export const ledger = (list: Verdict[]): Verdicts =>
  new Map(list.map((v) => [verdictKey(v.unit, v.hash), v]));

/** An add Life made on his words "write that down in the to-dos", unless `over` says otherwise. */
export const action = (over: Partial<Action> = {}): Action => ({
  after: { list: "Travel", title: "Buy checked baggage" },
  at: "2026-10-15T10:00:00.000Z",
  id: "act_0123456789ab",
  instruction: {
    at: "2026-10-15T09:59:00.000Z",
    quote: "write that down in the to-dos",
    ref: "job-1:3@2026-10-15T09:59:00.000Z",
  },
  kind: "add",
  madeBy: "session",
  result: "ok",
  schemaVersion: 1,
  target: "reminder:12",
  why: "he asked",
  ...over,
});
