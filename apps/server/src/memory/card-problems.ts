import type { z } from "zod";
import { DAY, HOUR } from "../core/clock";
import type { Ask, Option } from "./card-request";
import { type MatterStepNow, openStepsOf } from "./matter-read";
import { NEED_KINDS, payeeWordsOf } from "./needs";

// What breaks a card's rules beyond its shape (`requestDecision`), in words the asking agent can fix, each naming the
// ask page that explains it (`fetch("ask/<name>")`, `card-request.ts`).

const WHITESPACE = /\s+/;
/** What the contract has for `doneSeenBy` that Life cannot see yet. */
const DONE_SEEN_NOT_BUILT = ["call", "mail", "message", "visit"];

/** What a request uses that the asks contract has and Life does not build yet, named; false when nothing. */
export function notBuiltOf(r: {
  doneSeenBy?: unknown;
  options?: unknown;
  plan?: unknown;
}) {
  const options = (Array.isArray(r.options) ? r.options : []).filter(
    (o): o is Record<string, unknown> => typeof o === "object" && o !== null
  );
  const takes = options.find(
    (o) => o.takes !== undefined && o.takes !== "note"
  );
  return (
    (r.plan !== undefined && "`plan`") ||
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
  options: "options",
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

/** What breaks the card's rules beyond its shape, in words the agent can fix; false when nothing does. */
export function cardProblemOf(ask: z.infer<typeof Ask>, now: Date) {
  const ids = ask.options.map((o) => o.id);
  const ahead = Date.parse(ask.deadline) - now.getTime();
  const silence = ask.options.find((o) => o.id === ask.onSilence);
  return (
    (ask.context.trim() === "" &&
      "`context` is required, in Markdown: why you ask, why you drafted this, what you tried, with links") ||
    (new Set(ids).size !== ids.length && "option ids repeat") ||
    (ask.onSilence !== null &&
      !silence &&
      "`onSilence` must be an option id") ||
    (silence?.outgoing &&
      "`onSilence` never takes an `outgoing` option: on silence nothing goes out") ||
    lookProblemOf(ask, silence) ||
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

/** What breaks the rules of a `looks` or `takes` option and of `doneSeenBy`, in words the agent can fix; false when nothing does. */
function lookProblemOf(
  ask: z.infer<typeof Ask>,
  silence?: z.infer<typeof Option>
) {
  const looks = ask.options.filter((o) => o.looks);
  const marks = (o: z.infer<typeof Option>) =>
    [o.ends, o.looks, o.outgoing, o.takes].filter(Boolean).length;
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
