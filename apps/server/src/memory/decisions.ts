import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { clock, DAY, HOUR } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { isoDateTime } from "../records/fields";
import { readMatterBook } from "./matters";
import { MEMORY } from "./memory-files";
import { readPeople } from "./who";
import { dayNow } from "./zones";

// The decisions: a question an agent puts to him, with options, a recommendation and a deadline. Append-only, one
// synchronous line each, outside the lock like a correction: `asked` (`requestDecision`), his `answered` (the first
// wins) and the asker's `withdrawn`. Where each stands is worked out when read (`decisionsNow`); the open ones are
// checks (`checks.ts`), so he sees them in the one list. The file also holds the old decisions page's lines
// (schemaVersion 1, before 2 Nov 2026): kept, never read.

export const DECISIONS = join(MEMORY, "decisions.jsonl");

const PROJECT_OR_AREA = /^(?:project|area):/;
const DecisionId = z.string().regex(/^dec_[0-9a-f]{12}$/);
const Option = z
  .object({ id: z.string().min(1).max(40), label: z.string().min(1).max(200) })
  .strict();

/** What an asker gives (`requestDecision`, the connector's `request_decision`): an `asked` line less what Life stamps. */
export const Ask = z
  .object({
    /** The registered agent that asked (the desk's `agt_…`), when one did: stamped by the desk, never by the connector. */
    agent: z
      .string()
      .regex(/^agt_[0-9a-f]+$/)
      .optional(),
    context: z.string().max(4000).default(""),
    deadline: isoDateTime,
    links: z.array(z.url()).default([]),
    onSilence: z.string().nullable().default(null),
    options: z.array(Option).min(2).max(4),
    question: z.string().min(1).max(200),
    recommended: z.array(z.string()).min(1),
    /** A matter step's id (it rides on that matter: listed while the matter is open), or `project:<id>` or `area:<id>`; none for a task with neither. */
    subject: z.string().min(1).optional(),
    why: z.string().min(1).max(300),
  })
  .strict();
/** What an agent gives `request_decision` (the connector's, the door's): an `Ask` less the desk's stamp, or a withdrawal; `requestDecision` checks the rest. */
export const DecisionRequest = Ask.omit({ agent: true })
  .partial()
  .extend({
    why: Ask.shape.why,
    withdraw: z
      .string()
      .optional()
      .describe("A decision id you asked, to withdraw it (with `why`)"),
  });

const Asked = Ask.extend({
  asker: z.string().min(1),
  at: isoDateTime,
  id: DecisionId,
  kind: z.literal("asked"),
  schemaVersion: z.literal(2),
}).strict();
const Answered = z
  .object({
    at: isoDateTime,
    id: DecisionId,
    kind: z.literal("answered"),
    note: z.string().min(1).optional(),
    /** The option ids he picked; none when he answered in words. */
    options: z.array(z.string()),
    schemaVersion: z.literal(2),
    via: z.enum(["connector"]),
  })
  .strict();
const Withdrawn = z
  .object({
    at: isoDateTime,
    id: DecisionId,
    kind: z.literal("withdrawn"),
    schemaVersion: z.literal(2),
    why: z.string().min(1),
  })
  .strict();
const Line = z.discriminatedUnion("kind", [Asked, Answered, Withdrawn]);
/** A line of the old decisions page (schemaVersion 1): skipped. */
const Historical = z.object({ schemaVersion: z.literal(1) }).loose();
const Stored = z.union([Line, Historical]);

type Asked = z.infer<typeof Asked>;
type Answered = z.infer<typeof Answered>;
type Withdrawn = z.infer<typeof Withdrawn>;

type DecisionState = "answered" | "lapsed" | "open" | "withdrawn";
export type Decision = Asked & {
  answer?: Answered;
  state: DecisionState;
  withdrawn?: Withdrawn;
};

/** Every decision as stored, by id, in the order asked: the first answer kept. */
const readAll = () =>
  readAppended(
    DECISIONS,
    Stored,
    (last?: Map<string, Omit<Decision, "state">>) => new Map(last),
    (all, l) => {
      if (l.schemaVersion !== 2) {
        return;
      }
      const d = all.get(l.id);
      if (l.kind === "asked") {
        all.set(l.id, l);
      } else if (d && l.kind === "answered" && !d.answer) {
        all.set(l.id, { ...d, answer: l });
      } else if (d && l.kind === "withdrawn" && !d.withdrawn) {
        all.set(l.id, { ...d, withdrawn: l });
      }
    }
  );

const stateOf = (d: Omit<Decision, "state">, now: Date): DecisionState => {
  if (d.answer) {
    return "answered";
  }
  if (d.withdrawn) {
    return "withdrawn";
  }
  return Date.parse(d.deadline) <= now.getTime() ? "lapsed" : "open";
};

/** Every decision with where it stands at `now`: open, answered, lapsed (its deadline passed) or withdrawn. */
export const decisionsNow = (now = clock()): Decision[] =>
  [...readAll().values()].map((d) => ({ ...d, state: stateOf(d, now) }));

function readOpenDecision(id: string, now: Date) {
  const d = decisionsNow(now).find((x) => x.id === id);
  if (!d) {
    throw new Error(`Not done: no decision ${id}.`);
  }
  if (d.state !== "open") {
    throw new Error(
      `Not done: ${id} is ${d.state}${d.answer ? ` (${d.answer.at})` : ""}.`
    );
  }
  return d;
}

/** Whether a decision's subject is a matter step (else a project, an area or none). */
export const isOnMatter = (subject?: string): subject is string =>
  subject !== undefined && !PROJECT_OR_AREA.test(subject);

/** Records a decision `asker` (an agent's pairing, or `desk`) asks, or its withdrawal by that same asker. */
export async function requestDecision(
  asker: string,
  // Partial: an agent's arguments arrive unchecked; `Ask` checks them here.
  request:
    | Partial<z.input<typeof Ask>>
    | { agent?: string; why: string; withdraw: string },
  now = clock()
): Promise<{ id: string }> {
  const at = now.toISOString();
  if ("withdraw" in request) {
    const d = readOpenDecision(request.withdraw, now);
    // Every registered agent asks as `desk`: its own `agent` tells them apart.
    if (d.asker !== asker || d.agent !== request.agent) {
      throw new Error(`Not done: ${d.id} was asked by another agent.`);
    }
    appendJsonl(DECISIONS, Withdrawn, [
      { at, id: d.id, kind: "withdrawn", schemaVersion: 2, why: request.why },
    ]);
    return { id: d.id };
  }
  const parsed = Ask.safeParse(request);
  if (!parsed.success) {
    throw new Error(`Not done: ${z.prettifyError(parsed.error)}`);
  }
  const ask = parsed.data;
  const ids = ask.options.map((o) => o.id);
  const ahead = Date.parse(ask.deadline) - now.getTime();
  const problem =
    (new Set(ids).size !== ids.length && "option ids repeat") ||
    ([...ask.recommended, ...(ask.onSilence ? [ask.onSilence] : [])].some(
      (o) => !ids.includes(o)
    ) &&
      "`recommended` and `onSilence` must be option ids") ||
    ((ahead < HOUR || ahead > 14 * DAY) &&
      "the deadline must be 1 hour to 14 days ahead");
  if (problem) {
    throw new Error(`Not done: ${problem}.`);
  }
  // A registered agent asks him one thing at a time (an inbox rule, not a limit on its work).
  const open = ask.agent
    ? decisionsNow(now).find((d) => d.agent === ask.agent && d.state === "open")
    : undefined;
  if (open) {
    throw new Error(
      `Not done: ${ask.agent} already asks ${open.id}; withdraw it or wait for his answer.`
    );
  }
  // A step no open matter holds would never be listed: refused, so no question goes unseen.
  if (
    isOnMatter(ask.subject) &&
    !(await readMatterBook(await readPeople(), dayNow())).some(
      (m) => m.open && m.steps.some((x) => x.ref === ask.subject)
    )
  ) {
    throw new Error(
      `Not done: no open matter holds ${ask.subject}; give its step id, \`project:<id>\`, \`area:<id>\` or no subject.`
    );
  }
  const id = `dec_${randomBytes(6).toString("hex")}`;
  appendJsonl(DECISIONS, Asked, [
    {
      ...ask,
      asker,
      at,
      // In UTC, so deadlines sort as strings (`checksOf`).
      deadline: new Date(ask.deadline).toISOString(),
      id,
      kind: "asked",
      schemaVersion: 2,
    },
  ]);
  return { id };
}

/** Records his answer to an open decision: option ids, or none with his words. The first answer stands; a second is refused. */
export function answerDecision(
  id: string,
  options: string[],
  note?: string,
  now = clock()
) {
  const d = readOpenDecision(id, now);
  const unknown = options.filter((o) => !d.options.some((x) => x.id === o));
  if (unknown.length > 0 || (options.length === 0 && !note)) {
    throw new Error(
      unknown.length > 0
        ? `Not done: ${unknown.join(", ")} not among ${id}'s options.`
        : "Not done: pick an option or give his words as `note`."
    );
  }
  const line: Answered = {
    at: now.toISOString(),
    id,
    kind: "answered",
    ...(note ? { note } : {}),
    options,
    schemaVersion: 2,
    via: "connector",
  };
  appendJsonl(DECISIONS, Answered, [line]);
  return line;
}

/**
 * The decisions answered or lapsed in [`from`, `to`), by when: his answer's instant, or the deadline for a lapse (a
 * withdrawal is the asker's own act). Half-open, so a poll's next window starts at this one's end and none is seen twice
 * or skipped.
 */
export const settledBetween = (list: Decision[], from: Date, to: Date) =>
  list
    .map((d) => ({ at: Date.parse(d.answer?.at ?? d.deadline), d }))
    .filter(
      ({ at, d }) =>
        (d.state === "answered" || d.state === "lapsed") &&
        at >= from.getTime() &&
        at < to.getTime()
    )
    .toSorted((a, b) => a.at - b.at)
    .map((x) => x.d);

/** When a decision is pushed: as its deadline comes within 24 hours, or when asked if it already has. */
const pushAtOf = (d: Decision) =>
  Math.max(Date.parse(d.at), Date.parse(d.deadline) - DAY);

/** The open decisions whose push instant falls in (`since`, `now`]: each is due once. */
export const pushDueOf = (list: Decision[], since: Date, now: Date) =>
  list.filter(
    (d) =>
      d.state === "open" &&
      pushAtOf(d) > since.getTime() &&
      pushAtOf(d) <= now.getTime()
  );
