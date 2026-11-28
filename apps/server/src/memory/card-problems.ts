import type { z } from "zod";
import { apifyToken } from "../apify/backend";
import { DAY, HOUR } from "../core/clock";
import { isOn } from "../core/outputs";
import { isLifeActIcon } from "../records/answer-icon";
import type { Ask, Option } from "./card-request";
import type { Decision } from "./decision-lines";
import { effectOf, instructionsFor } from "./instructions";
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

/** What breaks the card's rules beyond its shape, in words the agent can fix; false when nothing does. */
export function cardProblemOf(ask: z.infer<typeof Ask>, now: Date) {
  const ids = ask.options.map((o) => o.id);
  const ahead = Date.parse(ask.deadline) - now.getTime();
  const silence = ask.options.find((o) => o.id === ask.onSilence);
  return (
    (new Set(ids).size !== ids.length && "option ids repeat") ||
    (ask.edits &&
      !ask.draft &&
      "`edits` go only with a `draft`: quick changes to its message") ||
    silenceProblemOf(ask, silence) ||
    marksProblemOf(ask, silence) ||
    planProblemOf(ask) ||
    (ask.draft &&
      ask.options.filter((o) => o.outgoing).length !== 1 &&
      "a `draft` needs the one option that sends it marked `outgoing`") ||
    (!ask.question.trim().endsWith("?") && "`question` must end in a ?") ||
    ((ahead < HOUR || ahead > 14 * DAY) &&
      "the deadline must be 1 hour to 14 days ahead") ||
    answersProblemOf(ask) ||
    loadProblemOf(ask)
  );
}

/** A Markdown link's target, a quote line (someone else's words) and code: none of them his card's own words. */
const NOT_OWN_WORDS = [
  /\]\([^)]*\)/g,
  /^ {0,3}>.*$/gm,
  /```[\s\S]*?```/g,
  /`[^`\n]*`/g,
];
/** What he reads of a card's text, as it asks: its own words, less links' targets, quotes and code. */
const ownWordsOf = (text: string) =>
  NOT_OWN_WORDS.reduce((t, re) => t.replace(re, ""), text);
/** An asker that says it did not check what it asks on (its own "I didn't…", or a "Couldn't verify" heading; never someone else's). ponytail: English words only. */
const HEDGE =
  /\bnot verified|^[\s*#-]*could ?n[o'’]t verify|\b(i|we) (could ?n[o'’]t|can ?n[o'’]t|was unable to|am unable to|have ?n[o'’]t|did ?n[o'’]t|did not|have not) (yet )?(verif|check|confirm|open|read|look)\w*|\bi'?m unable to (verif|check|confirm)\w*/im;
/** What he never reads on a card: a stored ref, or a name of Life's roles and plumbing (the technology disappears, his word of 22 Nov 2026). */
const INTERNAL =
  /\b((obs|unit|matter|dec|agt|asg|apt)_[0-9a-f]{6,}|personal agent|main session|request_decision|life's connector)\b/i;
/** The most of `context` he reads, as `ownWordsOf` counts it (most cards hold under 1,100). */
const CONTEXT_CHARS = 1200;

/** What code can see of the self-check (`CARD_SELF_CHECK`): a card that says it left something unchecked, shows an id or a role's name, or holds more than he needs to read; false when nothing does. */
function loadProblemOf(ask: z.infer<typeof Ask>) {
  const context = ownWordsOf(ask.context);
  const read = [
    ask.title,
    ask.question,
    context,
    ask.gathered?.text ?? "",
    ...ask.options.map((o) => o.label),
    ...(ask.plan ?? []).flatMap((p) => [p.text, p.when ?? ""]),
  ].join("\n");
  const hedge = HEDGE.exec([ask.title, ask.question, context].join("\n"));
  const internal = INTERNAL.exec(read);
  return (
    (hedge &&
      `"${hedge[0]}": check it with your tools before asking; a fact no tool reaches that decides the card is its question, asked plainly, never a note of what you did not check`) ||
    (internal &&
      `"${internal[0]}" is Life's inside: he reads no ids and no names of agents or roles; link Life's things as \`[words](life:<ref>)\``) ||
    (context.length > CONTEXT_CHARS &&
      `\`context\` holds ${context.length} characters as he reads them (${CONTEXT_CHARS} at most): keep only what he needs to decide`)
  );
}

/** His own words, the last answer of every agent's card (the phone's), which no option repeats. */
const TELL = /^tell the agent\b/i;
/** An option that names the agent's own controls: those are his agent sheet's, and a pick of it only says the word. ponytail: English words only; a label in another language gets through. */
const AGENT_CONTROL = /\b(stop|pause|restart|resume|kill)\b.*\bagent\b/i;
/** A label after the first shares its row with two others: a third of the phone's row at its size. */
const SHARED_ROW_CHARS = 14;
/** The icons an `ends` option may take besides Life's done check: it drops the step or matter unwanted. */
const DROP_ICONS: readonly string[] = ["drop", "no"];

/** What breaks the one rule of a card's answers (`fetch("ask/options")`): 2 or 3 options, the first at most five words, the others short enough to share a row, no label twice, none repeating his own words or controlling the agent, and no icon of Life's acts; false when nothing does. */
function answersProblemOf(ask: z.infer<typeof Ask>) {
  const labels = ask.options.map((o) => o.label.trim().toLowerCase());
  const first = ask.options.find(
    (o) => o.id === (ask.recommended ?? ask.options[0]?.id)
  );
  const rest = ask.options.filter((o) => o !== first);
  return (
    (ask.options.length > 3 &&
      'at most 3 options: his own words, "Tell the agent…", are always the card\'s last answer (fetch("ask/options"))') ||
    (new Set(labels).size !== labels.length && "option labels repeat") ||
    (ask.options.some((o) => TELL.test(o.label.trim())) &&
      'no option is "Tell the agent…": his own words are always the card\'s last answer (fetch("ask/options"))') ||
    (ask.options.some((o) => AGENT_CONTROL.test(o.label.trim())) &&
      "no option controls the agent (stop, pause, restart): that is his agent sheet's, and a pick of it only says the word") ||
    ((first?.label.trim() ?? "").split(WHITESPACE).length > 5 &&
      "the recommended option's `label` is at most five words") ||
    (rest.some((o) => o.label.trim().length > SHARED_ROW_CHARS) &&
      `an option other than the recommended one is at most ${SHARED_ROW_CHARS} characters: they share the row below it`) ||
    (ask.options.some((o) => o.icon && isLifeActIcon(o.icon)) &&
      'the icons send, add_to_calendar, done and agent are Life\'s: it draws them on the options it acts on (fetch("ask/options"))') ||
    (ask.options.some(
      (o) => o.ends && o.icon && !DROP_ICONS.includes(o.icon)
    ) &&
      'an `ends` option closes the step or matter: no icon (Life draws done), or `drop` or `no` (fetch("ask/options"))') ||
    (ask.options.some((o) => o.icon && (o.outgoing || o.adds || o.looks)) &&
      'an `outgoing`, `adds` or `looks` option has no `icon`: Life draws its own (fetch("ask/options"))')
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

/** What breaks the rules of the options Life acts on (`looks`, `adds`, `runs`, `raises`), in words the agent can fix; false when nothing does. */
const marksProblemOf = (
  ask: z.infer<typeof Ask>,
  silence: z.infer<typeof Option> | undefined
) =>
  lookProblemOf(ask, silence) ||
  addsProblemOf(ask, silence) ||
  runsProblemOf(ask, silence) ||
  raisesProblemOf(ask, silence);

/** What breaks the rules of a `raises` option (the card a spending stop asks for), in words the agent can fix; false when nothing does. */
function raisesProblemOf(
  ask: z.infer<typeof Ask>,
  silence: z.infer<typeof Option> | undefined
) {
  const raises = ask.options.filter((o) => o.raises);
  return (
    (raises.length > 1 && "at most one `raises` option") ||
    (silence?.raises &&
      "`onSilence` never takes a `raises` option: on silence nothing goes over the stop") ||
    (raises.some(
      (o) => o.outgoing || o.adds || o.ends || o.looks || o.runs || o.takes
    ) &&
      "a `raises` option has no other mark")
  );
}

/** What breaks the rules of a `runs` option and the `apify` need it starts, in words the agent can fix; false when nothing does. */
function runsProblemOf(
  ask: z.infer<typeof Ask>,
  silence: z.infer<typeof Option> | undefined
) {
  const runs = ask.options.filter((o) => o.runs);
  const apify = ask.needs?.filter((n) => n.kind === "apify") ?? [];
  return (
    (runs.length !== (apify.length > 0 ? 1 : 0) &&
      'one `apify` need goes with exactly one `runs` option, and neither without the other (fetch("ask/apify"))') ||
    (apify.length > 1 && "at most one `apify` need") ||
    (silence?.runs &&
      "`onSilence` never takes a `runs` option: on silence nothing runs") ||
    (runs.some((o) => o.outgoing || o.adds || o.ends || o.looks || o.takes) &&
      'a `runs` option has no other mark (fetch("ask/apify"))') ||
    (ask.draft && runs.length > 0 && "a `runs` card has no `draft`") ||
    (apify.some((n) => n.estimateUsd > n.maxUsd) &&
      "an `apify` need's `estimateUsd` is at most its `maxUsd`") ||
    (apify.length > 0 &&
      !apifyToken() &&
      "Apify is not connected: he has no token in Life")
  );
}

/** What breaks the rules of a `looks` or `takes` option and of `doneSeenBy`, in words the agent can fix; false when nothing does. */
function lookProblemOf(
  ask: z.infer<typeof Ask>,
  silence?: z.infer<typeof Option>
) {
  const looks = ask.options.filter((o) => o.looks);
  const marks = (o: z.infer<typeof Option>) =>
    [o.adds, o.ends, o.looks, o.outgoing, o.runs, o.takes].filter(Boolean)
      .length;
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

/** An old plan card's option `id` as his app's role of it, `start` or `decline` (plan cards asked before 25 Nov 2026 may still be open); none for another id. */
export const planRoleOf = (id: string) =>
  (["start", "decline"] as const).find((r) => r === id);

/** A Markdown numbered-list line, outside quotes and code: a plan's step written as text. */
const NUMBERED_LINE = /^ {0,3}\d{1,2}[.)]\s/;
const CODE_BLOCK = /```[\s\S]*?```/g;

/** Whether `context` writes steps as a numbered list (two lines or more, quotes and code aside): a plan as text, which drew a wall of text on his phone (22 Nov 2026). */
const isNumberedListOf = (context: string) =>
  context
    .replace(CODE_BLOCK, "")
    .split("\n")
    .filter((l) => NUMBERED_LINE.test(l)).length >= 2;

/** What breaks the rules of a card's plan (`fetch("ask/plan")`): steps go in `plan`, never as a numbered list in `context` (his word of 22 Nov 2026), and `gathered` goes with `plan`; false when nothing does. */
const planProblemOf = (ask: z.infer<typeof Ask>) =>
  (isNumberedListOf(ask.context) &&
    'a numbered list in `context` is a plan as text: give its steps as `plan` and keep `context` to what you found, as bullets (fetch("ask/plan")); a list that is not steps goes as bullets') ||
  (ask.gathered &&
    !ask.plan &&
    '`gathered` goes with `plan`, its steps (fetch("ask/plan"))');

/** What breaks the rules of the fields every agent's card writes (`ask`, `recommended`, `follow`; the desk's door asks it); false when nothing does. */
function askFieldsProblemOf(ask: {
  ask?: string;
  follow?: unknown;
  options?: readonly { id: string }[];
  recommended?: string;
}) {
  const missing = (["ask", "recommended", "follow"] as const).filter(
    (k) => ask[k] === undefined
  );
  return (
    (missing.length > 0 &&
      `a card writes ${missing.map((k) => `\`${k}\``).join(", ")}: \`ask\` what he does in one short imperative line, \`recommended\` the id of the option you recommend, \`follow\` 0 to 3 next asks in his voice`) ||
    (!ask.options?.some((o) => o.id === ask.recommended) &&
      "`recommended` is one of the options' ids")
  );
}

/**
 * What refuses a card on the subject of an earlier card of the same asker that he never answered (it lapsed or was
 * withdrawn), unless it says what `changed`: the same subject is never asked twice. `earlier`: the asker's own cards,
 * `matter` the matter the new one rides on. False when nothing does.
 */
function repeatProblemOf(
  ask: Pick<z.infer<typeof Ask>, "changed" | "subject">,
  earlier: readonly Pick<Decision, "matter" | "state" | "subject">[],
  matter?: string
) {
  const isSame = (d: Pick<Decision, "matter" | "subject">) =>
    (ask.subject !== undefined &&
      (d.subject === ask.subject || d.matter === ask.subject)) ||
    (matter !== undefined && d.matter === matter);
  return (
    !ask.changed &&
    earlier.some(
      (d) => (d.state === "lapsed" || d.state === "withdrawn") && isSame(d)
    ) &&
    "you asked on this subject before and he never answered: ask again only with `changed`, what changed (a deadline, a condition, an option, the message, an edit)"
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

/** What refuses a card's draft where his instructions in force (`inForce`, `instructionsFor`) say Life drafts no replies (`no-drafts` over `drafts`, `effectOf`); false when nothing does. */
const draftsProblemOf = (
  ask: Pick<z.infer<typeof Ask>, "draft">,
  inForce: Parameters<typeof effectOf>[0]
) =>
  ask.draft !== undefined &&
  effectOf(inForce, "drafts", "no-drafts") === false &&
  "he asked Life to draft no replies here: ask what you need without a `draft`, or leave the reply to him";

/**
 * What refuses an agent's card at the desk's door beyond `cardProblemOf`, and the ids of his instructions in force on it
 * (`instructionsFor`: its matter, its agent's `project`, its draft's channel, chat and person), kept on its line: a field
 * every agent's card writes missing, a draft he refused, a subject asked again unanswered without `changed` (`earlier`:
 * the assignment's own cards).
 */
export function agentCardOf(
  ask: Parameters<typeof askFieldsProblemOf>[0] &
    Pick<z.infer<typeof Ask>, "changed" | "draft" | "subject">,
  earlier: readonly Pick<Decision, "matter" | "state" | "subject">[],
  on: { matter?: string; project?: string | null }
) {
  const inForce = instructionsFor({
    channels: [ask.draft?.channel, ask.draft?.to].filter(
      (c) => c !== undefined
    ),
    matter: on.matter,
    people: ask.draft?.to.startsWith("person:") ? [ask.draft.to] : [],
    projects: on.project ? [on.project] : [],
  });
  return {
    instructions: inForce.map((i) => i.id),
    problem:
      askFieldsProblemOf(ask) ||
      draftsProblemOf(ask, inForce) ||
      repeatProblemOf(ask, earlier, on.matter),
  };
}
