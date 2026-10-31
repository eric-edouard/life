import { clock, iso } from "../core/clock";
import { appendJsonl, rowsOf } from "../core/files";
import {
  AnsweredLine,
  type Decision,
  DecisionAsk,
  DecisionLine,
} from "../records/decision";
import { DECISIONS } from "./ledger";

// His decisions as they stand: the fold of memory/decisions.jsonl (records/decision.ts), never stored. Every write
// goes through `writeDecision`, synchronous from reading the file to appending, so his tap and a loop taking the
// same decision can't both land (one connector and one page, in the same server).

type Status = Decision["status"];

/** One line's effect on its decision (none before it was asked). */
function apply(d: Decision | undefined, l: DecisionLine): Decision | undefined {
  const s = l.data as Record<string, unknown>;
  if (l.step === "asked") {
    return {
      ...(s as unknown as DecisionAsk),
      agent: l.agent,
      createdAt: l.at,
      id: l.decision,
      status: "open",
    };
  }
  if (!d) {
    return undefined;
  }
  switch (l.step) {
    case "revised":
      // The whole decision again: nothing of the old ask stays.
      return {
        ...(s as unknown as DecisionAsk),
        agent: d.agent,
        createdAt: d.createdAt,
        id: d.id,
        result: d.result,
        status: "open",
      };
    case "answered": {
      const read = AnsweredLine.parse(s);
      const answer = read.answer ?? null;
      const note = read.note ?? "";
      return {
        ...d,
        answer,
        answeredAt: answer ? (d.answeredAt ?? l.at) : undefined,
        note,
        status: answer ? "answered" : "open",
      };
    }
    case "taken":
      return { ...d, status: "taken" };
    case "reopened":
      return {
        ...d,
        answer: null,
        answeredAt: undefined,
        note: "",
        result: `${s.result}`,
        status: "open",
      };
    case "done":
    case "withdrawn":
    case "expired":
      return {
        ...d,
        closedAt: l.at,
        result: `${s.result}`,
        scope: s.scope as string | undefined,
        status: l.step,
      };
    case "context":
      return { ...d, contextOpenedAt: d.contextOpenedAt ?? l.at };
    case "revoked":
      return { ...d, revokedAt: l.at };
    default:
      return d;
  }
}

/** Marks the grants that stand: per loop and ref only the newest done one counts, and a "no" (no scope) or a revoke turns it off. */
function markActive(all: Map<string, Decision>) {
  const newest = new Map<string, Decision>();
  for (const d of all.values()) {
    const key = `${d.loop} ${d.ref}`;
    if (
      d.kind === "grant" &&
      d.status === "done" &&
      (newest.get(key)?.createdAt ?? "") <= d.createdAt
    ) {
      newest.set(key, d);
    }
  }
  for (const d of newest.values()) {
    d.active = Boolean(d.scope && !d.revokedAt);
  }
}

/** A new decision's id: its loop, the instant to the millisecond, its number in the write. */
export const decisionId = (loop: string, now: number, n = 1) =>
  `${loop}-${iso(now).replace(/\D/g, "").slice(0, 17)}-${n}`;

/** Every decision as it stands now, by id. */
export function decisionsNow(
  lines: DecisionLine[] = rowsOf(DECISIONS, DecisionLine)
) {
  const all = new Map<string, Decision>();
  for (const l of lines) {
    const d = apply(all.get(l.decision), l);
    if (d) {
      all.set(l.decision, d);
    }
  }
  markActive(all);
  return all;
}

/** From which states each step may go; a request (no options) is also taken open: there is nothing to answer. */
const ALLOWED: Record<string, Status[]> = {
  answered: ["open", "answered"],
  context: ["open", "answered", "taken"],
  done: ["taken"],
  expired: ["open"],
  reopened: ["answered", "taken"],
  revised: ["open"],
  revoked: ["done"],
  taken: ["answered"],
  withdrawn: ["open"],
};
const NEEDS_RESULT = ["done", "reopened", "withdrawn", "expired"];

const issues = (e: { issues: { message: string; path: PropertyKey[] }[] }) =>
  e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");

/** What one step itself needs, once the decision may take it. */
function stepRefusal(
  d: Decision,
  step: DecisionLine["step"],
  data: Record<string, unknown>,
  now: number
) {
  if (NEEDS_RESULT.includes(step) && !data.result) {
    return `${step} needs result`;
  }
  if (step === "revised") {
    const ask = DecisionAsk.safeParse(data);
    return ask.success
      ? null
      : `a revision is the whole decision again: ${issues(ask.error)}`;
  }
  if (step === "answered") {
    const a = data.answer;
    return a === null || a === "note" || d.options.some((o) => o.id === a)
      ? null
      : "answer is one of its options, note, or null";
  }
  if (step === "expired") {
    return Date.parse(d.deadline ?? "") <= now ? null : "not past its deadline";
  }
  return step === "revoked" && d.kind !== "grant"
    ? "only a grant is revoked"
    : null;
}

/** Why a step is refused on a decision as it stands, or null: the rules every writer meets. */
function refusalOf(
  d: Decision | undefined,
  step: DecisionLine["step"],
  data: Record<string, unknown>,
  now: number
) {
  if (step === "asked") {
    const ask = DecisionAsk.safeParse(data);
    if (d) {
      return `${d.id} exists: revise it instead`;
    }
    return ask.success ? null : `not a decision: ${issues(ask.error)}`;
  }
  if (!d) {
    return "no such decision";
  }
  const isRequest = step === "taken" && d.options.length === 0;
  return ALLOWED[step]?.includes(d.status) || isRequest
    ? stepRefusal(d, step, data, now)
    : `${d.id} is ${d.status}: no ${step} now`;
}

/** Appends the steps when every one is allowed, in order (one read, one append); throws why not. Returns the decisions they leave. */
export function writeDecision(
  steps: {
    agent?: string;
    data?: Record<string, unknown>;
    decision: string;
    run?: string;
    step: DecisionLine["step"];
  }[],
  now = clock().getTime()
) {
  const lines = rowsOf(DECISIONS, DecisionLine);
  const made: DecisionLine[] = [];
  for (const s of steps) {
    const all = decisionsNow([...lines, ...made]);
    const why = refusalOf(all.get(s.decision), s.step, s.data ?? {}, now);
    if (why) {
      throw new Error(why);
    }
    made.push({
      ...(s.agent ? { agent: s.agent } : {}),
      at: iso(now),
      data: s.data ?? {},
      decision: s.decision,
      ...(s.run ? { run: s.run } : {}),
      schemaVersion: 1,
      step: s.step,
    });
  }
  appendJsonl(DECISIONS, DecisionLine, made);
  const after = decisionsNow([...lines, ...made]);
  return steps.map((s) => after.get(s.decision) as Decision);
}
