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
// goes through `writeDecision`, synchronous from reading the file to appending, so his tap and Life closing the same
// decision can't both land (one page and the nightly's fact checks, in the same server).

/** The one kind of decision: Life's fact checks (`memory/fact-checks.ts`). */
export const FACT_CHECKS = "fact-checks";

type Status = Decision["status"];

/** One line's effect on its decision (none before it was asked, and none for an old loop's). */
function apply(d: Decision | undefined, l: DecisionLine): Decision | undefined {
  const s = l.data as Record<string, unknown>;
  if (l.step === "asked") {
    return s.loop === FACT_CHECKS
      ? {
          ...(s as unknown as DecisionAsk),
          createdAt: l.at,
          id: l.decision,
          status: "open",
        }
      : undefined;
  }
  if (!d) {
    return undefined;
  }
  switch (l.step) {
    case "answered": {
      const read = AnsweredLine.parse(s);
      const answer = read.answer ?? null;
      return {
        ...d,
        answer,
        answeredAt: answer ? (d.answeredAt ?? l.at) : undefined,
        note: read.note ?? "",
        status: answer ? "answered" : "open",
      };
    }
    case "done":
    case "expired":
      return { ...d, closedAt: l.at, result: `${s.result}`, status: l.step };
    default:
      return d;
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
  return all;
}

/** One step a writer asks for: Life's (asked, done, expired) or his (answered). */
interface Step {
  data?: Record<string, unknown>;
  decision: string;
  step: "asked" | "answered" | "done" | "expired";
}

/** From which states each step may go. */
const ALLOWED: Record<Exclude<Step["step"], "asked">, Status[]> = {
  answered: ["open", "answered"],
  done: ["answered"],
  expired: ["open"],
};

const issues = (e: { issues: { message: string; path: PropertyKey[] }[] }) =>
  e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");

/** Why a step is refused on a decision as it stands, or null. */
function refusalOf(
  d: Decision | undefined,
  { data = {}, step }: Step,
  now: number
) {
  if (step === "asked") {
    const ask = DecisionAsk.safeParse(data);
    if (d) {
      return `${d.id} exists`;
    }
    return ask.success ? null : `not a decision: ${issues(ask.error)}`;
  }
  if (!d) {
    return "no such decision";
  }
  if (!ALLOWED[step].includes(d.status)) {
    return `${d.id} is ${d.status}: no ${step} now`;
  }
  if (step === "answered") {
    const a = data.answer;
    return a === null || a === "note" || d.options.some((o) => o.id === a)
      ? null
      : "answer is one of its options, note, or null";
  }
  if (!data.result) {
    return `${step} needs result`;
  }
  return step === "expired" && Date.parse(d.deadline ?? "") > now
    ? "not past its deadline"
    : null;
}

/** Appends the steps when every one is allowed, in order (one read, one append); throws why not. Returns the decisions they leave. */
export function writeDecision(steps: Step[], now = clock().getTime()) {
  const lines = rowsOf(DECISIONS, DecisionLine);
  const made: DecisionLine[] = [];
  for (const s of steps) {
    const why = refusalOf(
      decisionsNow([...lines, ...made]).get(s.decision),
      s,
      now
    );
    if (why) {
      throw new Error(why);
    }
    made.push({
      at: iso(now),
      data: s.data ?? {},
      decision: s.decision,
      schemaVersion: 1,
      step: s.step,
    });
  }
  appendJsonl(DECISIONS, DecisionLine, made);
  const after = decisionsNow([...lines, ...made]);
  return steps.map((s) => after.get(s.decision) as Decision);
}
