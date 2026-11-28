import { z } from "zod";
import { SourceName } from "../core/names";
import {
  ANSWER_ICONS,
  AnswerIcon,
  isLifeActIcon,
  LIFE_ACT_ICONS,
} from "../records/answer-icon";
import { ContextMarkdown, isoDateTime } from "../records/fields";
import { MessageDraft, oneLine } from "./draft";
import { NEED_KINDS, NEED_KINDS_LINE, Need, needPageOf } from "./needs";

// What an asker gives for a card (`requestDecision`, `decisions.ts`): its shape (`Ask`, strict), the tool's arguments
// (`DecisionRequest`, derived from it, loose where the contract grows), and how an agent learns to ask one, a little at
// a time (the asks contract): `CARD`, the short rules every tool that asks one shows, names each part in one line; the
// details of each come from `fetch("ask/<name>")` (`askPageOf`), so an agent reads only what it uses. The pages here are
// the parts that are no need's kind (`needs.ts` holds those).

/** How Life can see a card's step done (`doneSeenBy`). */
export const DONE_SEEN_BY = ["payment", "access", "tap"] as const;

export const Option = z
  .object({
    /** His pick of it alone makes Life write the card's `event` need into his calendar, once (`addEventByHisWord`); never taken on silence. */
    adds: z.literal(true).optional(),
    /** His pick of it alone is his word that the card's step (`step`: the subject, one of its matter's open steps) or its whole matter (`matter`) is done: Life closes it (`endByHisWord`). Never on an `outgoing` option, never taken on silence. */
    ends: z.enum(["step", "matter"]).optional(),
    /** Its icon, the asker's pick (`answerIconOf` draws Life's own on the options Life acts on). */
    icon: AnswerIcon.optional(),
    id: z.string().min(1).max(40),
    label: oneLine(120),
    /** His pick of it alone is his word that he did the card's step: Life looks for it done now (`doneSeenBy`). */
    looks: z.literal(true).optional(),
    /** An act that leaves Life (it sends, pays, books, deletes or changes something others see): never taken on silence. */
    outgoing: z.literal(true).optional(),
    /** His pick of it alone, in his own app, raises the spending stop this card was asked at, once (`isRaiseOf`): only on the card a stop asks for; never taken on silence. */
    raises: z.literal(true).optional(),
    /** His pick of it alone makes Life start the card's `apify` need's run, once (`runApifyByHisWord`); never taken on silence. */
    runs: z.literal(true).optional(),
    /** What his pick of it carries besides it: his words (`note`). */
    takes: z.literal("note").optional(),
  })
  .strict();
/** One plan step: what is done, by whom, its muted second line (`when`), and its end icon: a source (`SourceName`, as a draft's `channel`) or a kind. */
export const PlanStep = z
  .object({
    by: z.enum(["agent", "owner"]),
    channel: z
      .union([SourceName, z.enum(["payment", "place", "file"])])
      .optional(),
    text: oneLine(120),
    when: oneLine(80).optional(),
  })
  .strict();
/**
 * What a card that replaces an earlier one on the same subject says changed: without it, the same subject is never asked
 * twice. A redraft says how he asked it: `edit:tap` (a quick edit he tapped) or `edit:words` (his typed or spoken words).
 */
export const CHANGES = [
  "deadline",
  "condition",
  "option",
  "message",
  "edit:tap",
  "edit:words",
] as const;

/** Whether `changed` says the card is a redraft (`edit:tap` or `edit:words`). */
export const isRedraftOf = (changed: readonly string[] | undefined) =>
  changed?.some((c) => c.startsWith("edit:")) === true;
/** The most drafts one card holds (a batch). */
const MAX_DRAFTS = 20;
/** What an asker gives (`requestDecision`, the connector's `request_decision`): an `asked` line less what Life stamps. */
export const Ask = z
  .object({
    /** The registered agent that asked (the desk's `agt_…`), when one did: stamped by the desk, never by the connector. */
    agent: z
      .string()
      .regex(/^agt_[0-9a-f]+$/)
      .optional(),
    /** The short imperative line he reads first ("Pick a clinic for the scan"); required of a new card (`askFieldsProblemOf`), absent on cards asked before it. */
    ask: oneLine(80).optional(),
    /** On a card that replaces an earlier one on its subject: what changed (`CHANGES`). */
    changed: z.array(z.enum(CHANGES)).min(1).optional(),
    context: ContextMarkdown.default(""),
    deadline: isoDateTime,
    /** How Life sees the card's step done: `payment` (it looks in his accounts for the `amount` need paid to the payee), `access` (it checks his Mac for each step of the `access` need), or `tap` (only his word). */
    doneSeenBy: z.enum(DONE_SEEN_BY).optional(),
    draft: MessageDraft.optional(),
    /** A batch: several drafts, each into its own chat, all sent by his one pick of the `outgoing` option (`draftsOf`); never with `draft`. */
    drafts: z.array(MessageDraft).min(2).max(MAX_DRAFTS).optional(),
    /** On a draft card: up to three quick changes he can tap, a few words each ("More concise", "Warmer"). */
    edits: z.array(oneLine(30)).min(1).max(3).optional(),
    /** Up to three next asks he may make, each in his own voice ("Book the earliest one"); required of a new card, possibly empty. */
    follow: z.array(oneLine(80)).max(3).optional(),
    /** With `plan`: what its plan was gathered from, one line (the source chip), which opens its `context`. */
    gathered: z
      .object({ text: oneLine(120) })
      .strict()
      .optional(),
    links: z.array(z.url()).default([]),
    /** The card waiting on yours (`draft.contested`) that this one asks for both: Life withdraws yours, and the waiting card's asker hears this card's answer too. */
    merges: z
      .string()
      .regex(/^dec_[0-9a-f]{12}$/)
      .optional(),
    /** What he needs in hand to do the step, in the order to show them (`needs.ts`). */
    needs: z.array(Need).min(1).max(8).optional(),
    onSilence: z.string().nullable().default(null),
    options: z.array(Option).min(2).max(4),
    /** What happens after his yes, its steps in order (`fetch("ask/plan")`), on any card. */
    plan: z.array(PlanStep).min(1).max(12).optional(),
    question: oneLine(120),
    /** The id of the option Life recommends, drawn full width; required of a new card. */
    recommended: z.string().min(1).max(40).optional(),
    /** A matter's id or a step's (it rides on that matter: listed while the matter is open; an id is stored as its newest step), or `project:<id>` or `area:<id>`; none for a task with neither. */
    subject: z.string().min(1).optional(),
    title: oneLine(80),
  })
  .strict();
export const Withdrawal = z
  .object({
    agent: Ask.shape.agent,
    why: z.string().min(1).max(300),
    withdraw: z.string().describe("A decision id you asked, to withdraw it"),
  })
  .strict();
/** The holder's keep: the card waiting on its own (`draft.contested`) waits until its own settles, and its asker hears `why`. */
export const Keep = Withdrawal.omit({ withdraw: true }).extend({
  keep: z
    .string()
    .describe("A card waiting on yours (`draft.contested`), to keep yours"),
});

/** The self-check every asker runs on a card before asking it, in his voice (his word of 22 Nov 2026: put yourself in his shoes; what is surfaced must cut his load); `loadProblemOf` (`card-problems.ts`) refuses what code can see of it. */
export const CARD_SELF_CHECK = `Before any card, read it as he will, on his phone, with nothing else open, and ask: is this the clearest, lightest way to put it to him? 0. First check you can't do it yourself: ask only what is his (outward, spending, only he can). 1. Only what truly needs him: never a reminder of something he knows, a fact to confirm, or something already past (a call, a meeting, a date gone). 2. Checked first: read everything your tools reach that bears on it (the thread to its newest message, the mail, the chat, his payments); never hand him what you left unchecked, and never write what you did not check: a fact no tool reaches that decides the card is the question itself, asked plainly. 3. What, why, and what each answer does, in plain words a stranger would understand. 4. No ids, refs, jargon or names of agents and roles: he sees that Life works on it, never how. 5. Options he can tap without reading anything else, each saying what it does ("Send it", "Close it").`;

/** The card's rules in words, for every tool that asks one (the connector's `request_decision`, the door's). */
export const CARD = `${CARD_SELF_CHECK} One card: \`title\` (what you try to do, 80), \`ask\` (what he does, an imperative line, 80), \`question\` (what he decides, 120, ending in a ?), \`options\` (2 or 3 \`{id, label, icon?}\`), \`recommended\` (the best one's id: 5 words; the rest 14 letters), \`follow\` (0 to 3 next asks, in his voice), \`context\` (required Markdown, 1,200 characters he reads: why you ask, what you tried, what it rests on; Life's things as \`[words](life:<ref>)\`, each must open; quotes as \`> …\` then \`*source*\`; no numbered list), \`links\` (yours first), \`deadline\` (1 hour to 14 days ahead), \`onSilence\` (the option taken if he doesn't answer, or null), \`subject\` (a matter's id or a step's, off his list when the matter ends; or \`project:<id>\`, \`area:<id>\`). A card may add: \`draft\`, the exact message, sent on his yes, and its \`edits\`; \`changed\` (${CHANGES.join(", ")}: asking again on a subject he never answered); \`plan\`, steps after his yes; \`needs\`, what he needs in hand, each \`{kind, …}\`: ${NEED_KINDS_LINE}; \`doneSeenBy\`, how Life sees the step done (${DONE_SEEN_BY.map((b) => `\`${b}\``).join(", ")}); and on an option, what his pick does (\`outgoing\`, \`ends\`, \`looks\`, \`runs\`, \`takes\`). Read \`fetch("ask/<name>")\` before using one (\`draft\`, \`options\`, \`payment\`, \`plan\`, a need's kind). He can always answer in his own words (the answer's \`note\`).`;

/** Who a message goes to when a name fits several people (his direction of 27 Nov 2026): context first, his ask only when unsure. */
export const RECIPIENT_RULE =
  "when a name fits several people, pick the one the context makes certain (who the matter or ask is about, who he last wrote to about it: `read_chats` with `who`, `read_people_and_organizations`); only when it is not certain, ask him which one, the likeliest people as the answers, and nothing else";

const PAGES: Record<string, string> = {
  draft:
    "`draft`, the exact message to approve, shown to him in full: `channel` the source it goes through; `to` a chat key from `read_chats`, or a person with one 1:1 chat there (for mail, addresses; " +
    RECIPIENT_RULE +
    "); `text` (always written as he writes to that person: the communication style in your packet, `read_matter`, atop `read_chats` with `who`, or `read_people_and_organizations`; never a tone of your own), a `file` (an absolute path: he sees its name and size, and Life sends the bytes it reads when you ask), or a `reaction` (an emoji, which needs `onMessage` and nothing else); `onMessage` a message's id (`read_chats`, `read_new_events`; for mail, its id from `search` or `fetch`), replied to (or reacted to); `mentions` (`[{name, sender}]`: each `@name` in `text`, in its order, `sender` the sender id `read_chats` shows for that person in this chat); for mail only `from`, `subject`, `cc`. What the chat takes besides text (a file, a reply, a reaction, mentions) is the chat's own: `read_chats` with its `chat` says. Where it takes them, a draft may be a reply (`onMessage` with `text`) or a lone emoji `reaction` on a message; where it doesn't, never: it is refused when you ask. `edits`, up to 3 quick changes he can tap, a few words each ('More concise', 'Warmer'). Mark the one option that sends it `outgoing: true`: Life sends it exactly as shown when he picks that option alone (with his words added, or another option, nothing is sent), and `decision.answered` carries `send`, the sent message's id or its error. A failed send is never retried: ask a new card.",
  options: `Every card's answers: your 2 or 3 options, \`recommended\` naming the one you recommend (its label at most five words: it fills its row), then your alternatives and the plain no last ("Don't send", "Not now", "Drop it"), each 14 characters at most (they share the row below); then his own words, "Tell the agent…", always the card's last answer, so never an option of yours (no \`Edit\`, no "Tell …" option, no label twice). An option never controls you ("Stop the agent", "Pause"): that is his agent sheet's. His words: one that says he did a step himself is \`Mark as done\`; \`Send\` only ever sends the message itself. \`icon\`, optional, one of ${ANSWER_ICONS.filter((i) => !isLifeActIcon(i)).join(", ")}: Life draws its own on an option it acts on (\`outgoing\`, \`adds\`, \`looks\`: never give one there) and the done check on an \`ends\` option that has none (give one only to drop: \`drop\` or \`no\`); ${LIFE_ACT_ICONS.join(", ")} are Life's alone. What his pick of it alone (no words of his added) does, at most one mark each: \`outgoing: true\`, it acts outside Life (sends, pays, books, deletes or changes something others see): with a \`draft\`, it sends it (\`fetch("ask/draft")\`). \`ends: "step"\` (\`subject\` one of its matter's open steps) or \`ends: "matter"\`, it means the step or the matter is done: his pick closes that step, or every open step of the matter, in Life, and \`decision.answered\` carries \`end\`, its error if it failed. \`looks: true\`, he says he did the step: Life looks for it done now (\`doneSeenBy\`, \`fetch("ask/payment")\`). \`adds: true\`, with an \`event\` need: his pick writes that event into his calendar (\`fetch("ask/event")\`). \`runs: true\`, with an \`apify\` need: his pick starts that Apify run (\`fetch("ask/apify")\`). \`raises: true\`, only on the card your work's spending stop asks for: his pick lets the work go on past it, once. \`takes: "note"\`, his pick comes with his words (\`note\`): nothing else is done with it. \`onSilence\` never names an \`outgoing\`, \`adds\`, \`runs\`, \`ends\`, \`looks\` or \`takes\` option: on silence nothing goes out, runs, closes or is looked for.`,
  payment: `A payment he makes (a transfer, a bill paid online): \`needs\` with the \`account\` (or a \`link\` to pay online), the \`amount\`, and a \`text\` for the reference; \`doneSeenBy: "payment"\`; options "I've paid" marked \`looks: true\` and "Drop it" (\`icon: "drop"\`; \`ends: "matter"\` when nothing else is left). On his pick of the \`looks\` option alone, Life looks in his accounts for money out of exactly that amount in that currency to the payee (each word of the \`account\`'s \`holder\`, else the \`link\`'s \`vendor\`, a whole word of the bank's merchant line, a leading title aside: give the name as the bank shows it), booked on or after the card's day. Seen: the card ends and \`decision.answered\` carries \`doneSeen\` (\`state: "seen"\`, its \`eventId\`, read it with \`read_payments\`). Not found: the card is open again for him to check later, and you hear nothing. While the card is open, Life also looks every few minutes (a statement can come in days late): seen, the card ends with no answer of his, and \`decision.answered\` carries \`doneSeen\` and no \`answer\`. While payments are off in his settings, nothing is looked for: the option is a plain answer. Once it is paid, if the payee should hear it, ask the next card: a \`draft\` telling them it's paid (\`fetch("ask/draft")\`). Example: \`{"title":"Pay the dive course deposit","question":"Pay the deposit by Monday?","needs":[{"kind":"account","bank":"Kasikornbank","number":"012-3-45678-9","holder":"Blue Reef Diving Co., Ltd.","scheme":"th_account"},{"kind":"amount","value":4500,"currency":"THB"},{"kind":"text","label":"Reference","text":"DEP-12","copy":true}],"doneSeenBy":"payment","options":[{"id":"paid","label":"I've paid","looks":true},{"id":"drop","label":"Drop it","icon":"drop"}],"deadline":"…","subject":"…"}\`.`,
  plan: `\`plan\`, what happens after his yes, on any card that presents one, never a numbered list in \`context\`: its steps in order, 1 to 12, each \`{text, by, when?, channel?}\`: \`text\` one line; \`by\` \`agent\` (you do it) or \`owner\` (he does); \`when\` the muted second line (\`"once Kit answers, by Thu"\`); \`channel\` its icon, a source (\`whatsapp\`, \`imessage\`, \`mail\`, \`phone\`, as a draft's \`channel\`) or \`payment\`, \`place\`, \`file\`. \`gathered\` \`{text}\`, one line on what the plan rests on (\`"From Kit's quote and two others"\`), which opens the \`context\` (still required: what you found, as a few bullets, never the steps again); \`gathered\` goes only with \`plan\`. A plan never asks leave to read, research or draft: do those without a card.`,
};

const ASK_PAGE = /^ask\/([a-z_]+)$/;

/** Whether `id` is an ask page's (`ask/<name>`), which `fetch` opens. */
export const isAskPage = (id: string) => ASK_PAGE.test(id);

/** The page `fetch("ask/<name>")` opens: a part's rules, or a need kind's; none for another name. */
export function askPageOf(id: string) {
  const name = ASK_PAGE.exec(id)?.[1] ?? "";
  return Object.hasOwn(PAGES, name) ? PAGES[name] : needPageOf(name);
}

/** Why an ask page opens nothing: the pages there are. */
export const noAskPageOf = (id: string) =>
  `no page ${id}: ${[...Object.keys(PAGES), ...NEED_KINDS].map((p) => `ask/${p}`).join(", ")}`;

/**
 * What an agent gives `request_decision` (the connector's, the door's): an `Ask` less the desk's stamp, published loose
 * where the contract grows (`needs`, `doneSeenBy`, an option's marks, `plan`'s steps), so a new kind never changes the
 * tool's arguments; `requestDecision` checks the rest with `Ask`, and refuses what is not built yet. Or a withdrawal, or a keep.
 */
export const DecisionRequest = Ask.omit({ agent: true })
  .partial()
  .extend({
    doneSeenBy: z.string().optional(),
    gathered: z.looseObject({}).optional(),
    keep: Keep.shape.keep.optional(),
    needs: z.array(z.looseObject({ kind: z.string() })).optional(),
    options: z
      .array(z.looseObject({ id: z.string(), label: z.string() }))
      .optional(),
    plan: z.array(z.looseObject({})).optional(),
    why: Withdrawal.shape.why
      .optional()
      .describe("With `withdraw` or `keep`: why"),
    withdraw: Withdrawal.shape.withdraw.optional(),
  });
