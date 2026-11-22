import type { z } from "zod";
import { DAY, HOUR } from "../core/clock";
import { isOn } from "../core/outputs";
import { type Ask, type Option, PLAN_OPTIONS } from "./card-request";
import { type MatterStepNow, openStepsOf } from "./matter-read";
import { eventOf, NEED_KINDS, payeeWordsOf } from "./needs";

// What breaks a card's rules beyond its shape (`requestDecision`), in words the asking agent can fix, each naming the
// ask page that explains it (`fetch("ask/<name>")`, `card-request.ts`).

const WHITESPACE = /\s+/;
/** What the contract has for `doneSeenBy` that Life cannot see yet. */
const DONE_SEEN_NOT_BUILT = ["call", "mail", "message", "visit"];

/** What a request uses that the asks contract has and Life does not build yet, named; false when nothing. */
export function notBuiltOf(r: { doneSeenBy?: unknown; options?: unknown }) {
  const options = (Array.isArray(r.options) ? r.options : []).filter(
    (o): o is Record<string, unknown> => typeof o === "object" && o !== null
  );
  const takes = options.find(
    (o) => o.takes !== undefined && o.takes !== "note"
  );
  return (
    (options.some((o) => "cost" in o || "effect" in o || "pick" in o) &&
      "an option's `cost`, `effect` and `pick`") ||
    (takes && `\`takes: ${JSON.stringify(takes.takes)}\` (only \`note\`)`) ||
    (DONE_SEEN_NOT_BUILT.includes(String(r.doneSeenBy)) &&
      `\`doneSeenBy: "${r.doneSeenBy}"\` (only \`payment\` and \`tap\`)`)
  );
}

/** Parts whose rules are a page of their own, by the field that holds them. */
const PAGE_OF_FIELD: Record<string, string> = {
  doneSeenBy: "payment",
  draft: "draft",
  gathered: "plan",
  options: "options",
  plan: "plan",
};

/** Where to read about the first field `error` refused: its ask page (`fetch("ask/<name>")`), a need's by its kind. */
export function pageHintOf(request: { needs?: unknown }, error: z.ZodError) {
  const [field, i] = error.issues[0]?.path ?? [];
  const kind =
    field === "needs" && Array.isArray(request.needs)
      ? request.needs[Number(i)]?.kind
      : undefined;
  const page = NEED_KINDS.includes(kind) ? kind : PAGE_OF_FIELD[String(field)];
  return page ? ` Read fetch("ask/${page}").` : "";
}

/** What breaks the card's rules beyond its shape, in words the agent can fix; false when nothing does. `isPlan`: it must be a plan card, an assignment's first (the door's `asksPlanOf`). */
export function cardProblemOf(
  ask: z.infer<typeof Ask>,
  now: Date,
  isPlan = false
) {
  const ids = ask.options.map((o) => o.id);
  const ahead = Date.parse(ask.deadline) - now.getTime();
  const silence = ask.options.find((o) => o.id === ask.onSilence);
  return (
    (new Set(ids).size !== ids.length && "option ids repeat") ||
    silenceProblemOf(ask, silence) ||
    lookProblemOf(ask, silence) ||
    addsProblemOf(ask, silence) ||
    planProblemOf(ask, isPlan, silence) ||
    (ask.draft &&
      ask.options.filter((o) => o.outgoing).length !== 1 &&
      "a `draft` needs the one option that sends it marked `outgoing`") ||
    (!ask.question.trim().endsWith("?") && "`question` must end in a ?") ||
    (ask.options.find((o) => o.label.trim().split(WHITESPACE).length > 5) &&
      "an option's `label` is at most five words") ||
    ((ahead < HOUR || ahead > 14 * DAY) &&
      "the deadline must be 1 hour to 14 days ahead")
  );
}

/** What is wrong with the option `onSilence` names; false when nothing is. */
function silenceProblemOf(
  ask: z.infer<typeof Ask>,
  silence: z.infer<typeof Option> | undefined
) {
  return (
    (ask.onSilence !== null &&
      !silence &&
      "`onSilence` must be an option id") ||
    (silence?.outgoing &&
      "`onSilence` never takes an `outgoing` option: on silence nothing goes out")
  );
}

/** What breaks the rules of an `event` need's times and his calendar; false when nothing does. */
function eventProblemOf(ask: z.infer<typeof Ask>) {
  const event = eventOf(ask.needs);
  return (
    (event &&
      !(
        Date.parse(event.end) > Date.parse(event.start) &&
        Date.parse(event.start) > Date.parse(ask.deadline)
      ) &&
      'an `event` starts after the card\'s `deadline` and ends after it starts (fetch("ask/event"))') ||
    (event &&
      !isOn("appointmentsCalendar") &&
      "an `event` card needs his calendar set up: it is off in his settings")
  );
}

/** What breaks the rules of an `adds` option and the `event` need it writes, in words the agent can fix; false when nothing does. */
function addsProblemOf(
  ask: z.infer<typeof Ask>,
  silence: z.infer<typeof Option> | undefined
) {
  const adds = ask.options.filter((o) => o.adds);
  const events = ask.needs?.filter((n) => n.kind === "event") ?? [];
  return (
    (adds.length !== (events.length > 0 ? 1 : 0) &&
      'one `event` need goes with exactly one `adds` option, and neither without the other (fetch("ask/event"))') ||
    (events.length > 1 && "at most one `event` need") ||
    (silence?.adds &&
      "`onSilence` never takes an `adds` option: on silence nothing is added") ||
    (adds.some((o) => o.outgoing || o.ends || o.looks || o.takes) &&
      'an `adds` option has no other mark (fetch("ask/event"))') ||
    (ask.draft && adds.length > 0 && "an `adds` card has no `draft`") ||
    eventProblemOf(ask)
  );
}

/** What breaks the rules of a `looks` or `takes` option and of `doneSeenBy`, in words the agent can fix; false when nothing does. */
function lookProblemOf(
  ask: z.infer<typeof Ask>,
  silence?: z.infer<typeof Option>
) {
  const looks = ask.options.filter((o) => o.looks);
  const marks = (o: z.infer<typeof Option>) =>
    [o.adds, o.ends, o.looks, o.outgoing, o.takes].filter(Boolean).length;
  return (
    ((silence?.looks || silence?.takes) &&
      "`onSilence` never takes a `looks` or `takes` option: on silence he did nothing and said nothing") ||
    (ask.options.some((o) => (o.looks || o.takes) && marks(o) > 1) &&
      'an option that `looks` or `takes` his words has no other mark (fetch("ask/options"))') ||
    (looks.length > 1 && "at most one option `looks`") ||
    (looks.length > 0 &&
      ask.doneSeenBy !== "payment" &&
      'a `looks` option needs `doneSeenBy: "payment"` (fetch("ask/payment"))') ||
    (ask.doneSeenBy === "payment" &&
      ask.needs?.filter((n) => n.kind === "amount").length !== 1 &&
      '`doneSeenBy: "payment"` needs one `amount` need (fetch("ask/payment"))') ||
    (ask.doneSeenBy === "payment" &&
      payeeWordsOf(ask.needs).length === 0 &&
      '`doneSeenBy: "payment"` needs the payee\'s name as the bank shows it: the `account`\'s `holder` or the `link`\'s `vendor` (fetch("ask/payment"))')
  );
}

/** A plan card's option `id` as his app's role of it: `start` or `decline`; none for another id. */
export const planRoleOf = (id: string) =>
  PLAN_OPTIONS.find((o) => o.id === id)?.id;

/** A Markdown numbered-list line, outside quotes and code: a plan's step written as text. */
const NUMBERED_LINE = /^ {0,3}\d{1,2}[.)]\s/;
const CODE_BLOCK = /```[\s\S]*?```/g;

/** Whether `context` writes steps as a numbered list (two lines or more, quotes and code aside): a plan as text, which drew a wall of text on his phone (22 Nov 2026). */
const isNumberedListOf = (context: string) =>
  context
    .replace(CODE_BLOCK, "")
    .split("\n")
    .filter((l) => NUMBERED_LINE.test(l)).length >= 2;

/** What breaks the plan card's rules (`fetch("ask/plan")`): a card that presents a plan gives it as `plan`, its steps, never as a numbered list in `context` (his word of 22 Nov 2026); the assignment's plan card always does (`isPlan`, 21 Nov 2026); `gathered` goes with `plan`; its two options, `start` and `decline`; false when nothing does. */
function planProblemOf(
  ask: z.infer<typeof Ask>,
  isPlan: boolean,
  silence?: z.infer<typeof Option>
) {
  const resend =
    'give its steps as `plan`, with options exactly `start` and `decline`, and keep `context` to what you found, as bullets (fetch("ask/plan"))';
  if (isNumberedListOf(ask.context)) {
    return `a numbered list in \`context\` is a plan as text: ${resend}; a list that is not steps goes as bullets`;
  }
  if (!ask.plan) {
    return (
      (isPlan && `an assignment's first card is its plan card: ${resend}`) ||
      (ask.gathered &&
        'a plan card with `gathered` gives `plan`, its steps (fetch("ask/plan"))')
    );
  }
  return (
    ((ask.options.length !== PLAN_OPTIONS.length ||
      PLAN_OPTIONS.some(
        (p) => !ask.options.some((o) => o.id === p.id && o.label === p.label)
      )) &&
      `a plan card's options are exactly ${JSON.stringify(PLAN_OPTIONS)} (fetch("ask/plan"))`) ||
    (ask.options.some((o) => o.ends || o.looks || o.outgoing || o.takes) &&
      'a plan card\'s options have no mark (fetch("ask/plan"))') ||
    (silence?.id === "start" &&
      "`onSilence` never takes `start`: on silence no plan starts") ||
    (ask.doneSeenBy &&
      "a plan card has no `doneSeenBy`: only his pick answers it")
  );
}

/**
 * What breaks the rules of an `ends` option, in words the agent can fix; false when nothing does. `matter`: the open
 * matter the subject is or rides on. A step's card closes its subject, which must be one of the matter's open steps
 * (`openStepsOf`); a matter's needs one open (nothing else closes a matter by his word).
 */
export function endsProblemOf(
  ask: z.infer<typeof Ask>,
  matter?: { id: string; steps: readonly MatterStepNow[] }
) {
  const ends = ask.options.filter((o) => o.ends);
  if (ends.length === 0) {
    return false;
  }
  return (
    (ends.some((o) => o.outgoing) &&
      "an option acts outside Life (`outgoing`) or closes in Life (`ends`), never both") ||
    (ends.some((o) => o.id === ask.onSilence) &&
      "`onSilence` never takes an `ends` option: only his pick closes anything") ||
    (!matter &&
      "`ends` needs a `subject` on an open matter (its id or a step's)") ||
    (ends.some((o) => o.ends === "step") &&
      (matter?.id === ask.subject ||
        openStepsOf(matter ?? { steps: [] }, ask.subject).length === 0) &&
      "`ends: \"step\"` needs `subject` to be one of the matter's open steps (a to-do, promise, wait or to-do item), not the matter's id") ||
    (openStepsOf(matter ?? { steps: [] }).length === 0 &&
      '`ends: "matter"` needs an open to-do, promise, wait or to-do item on the matter')
  );
}
