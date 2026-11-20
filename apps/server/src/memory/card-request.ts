import { z } from "zod";
import { isoDateTime } from "../records/fields";
import { MessageDraft, oneLine } from "./draft";
import { NEED_KINDS, NEED_KINDS_LINE, Need, needPageOf } from "./needs";

// What an asker gives for a card (`requestDecision`, `decisions.ts`): its shape (`Ask`, strict), the tool's arguments
// (`DecisionRequest`, derived from it, loose where the contract grows), and how an agent learns to ask one, a little at
// a time (the asks contract): `CARD`, the short rules every tool that asks one shows, names each part in one line; the
// details of each come from `fetch("ask/<name>")` (`askPageOf`), so an agent reads only what it uses. The pages here are
// the parts that are no need's kind (`needs.ts` holds those).

export const Option = z
  .object({
    /** His pick of it alone is his word that the card's step (`step`: the subject, one of its matter's open steps) or its whole matter (`matter`) is done: Life closes it (`endByHisWord`). Never on an `outgoing` option, never taken on silence. */
    ends: z.enum(["step", "matter"]).optional(),
    id: z.string().min(1).max(40),
    label: oneLine(120),
    /** His pick of it alone is his word that he did the card's step: Life looks for it done now (`doneSeenBy`). */
    looks: z.literal(true).optional(),
    /** An act that leaves Life (it sends, pays, books, deletes or changes something others see): never taken on silence. */
    outgoing: z.literal(true).optional(),
    /** What his pick of it carries besides it: his words (`note`). */
    takes: z.literal("note").optional(),
  })
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
    /** How Life sees the card's step done: `payment` (it looks in his accounts for the `amount` need), or `tap` (only his word). */
    doneSeenBy: z.enum(["payment", "tap"]).optional(),
    draft: MessageDraft.optional(),
    links: z.array(z.url()).default([]),
    /** What he needs in hand to do the step, in the order to show them (`needs.ts`). */
    needs: z.array(Need).min(1).max(8).optional(),
    onSilence: z.string().nullable().default(null),
    /** The recommended one first. */
    options: z.array(Option).min(2).max(4),
    question: oneLine(120),
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

/** The card's rules in words, for every tool that asks one (the connector's `request_decision`, the door's). */
export const CARD = `One card: \`title\` (what you are trying to do, one line, 80 characters), \`question\` (what he decides, one line, 120, ending in a ?), \`options\` (2 to 4 \`{id, label}\`, a label at most five words, the recommended one first), \`context\` (why, what was tried, what it rests on, with links: folded, about 10 lines), \`links\` (yours first), \`deadline\` (1 hour to 14 days ahead), \`onSilence\` (the option you take if he doesn't answer, or null), \`subject\` (a matter's id or one of its steps': it leaves his list when the matter ends; or \`project:<id>\`, \`area:<id>\`). A card may add: \`draft\`, the exact message he approves, which Life sends on his yes; \`needs\`, what he needs in hand, each \`{kind, …}\`: ${NEED_KINDS_LINE}; \`doneSeenBy\`, how Life sees the step done: \`payment\` (Life looks in his accounts) or \`tap\` (only his word); and on an option, what his pick does (\`outgoing\`, \`ends\`, \`looks\`, \`takes\`). Read \`fetch("ask/<name>")\` before using any of them (\`draft\`, \`options\`, \`payment\`, or a need's kind). He can always answer in his own words instead (the answer's \`note\`).`;

const PAGES: Record<string, string> = {
  draft:
    "`draft`, the exact message to approve, shown to him in full: `channel` the source it goes through; `to` a chat key from `read_chats`, or a person with one 1:1 chat there (for mail, addresses); `text` (written as he writes to that person: the communication style in your packet, `read_matter`, atop `read_chats` with `who`, or `read_person_page`; never a tone of your own), a `file` (an absolute path: he sees its name and size, and Life sends the bytes it reads when you ask), or a `reaction` (an emoji, which needs `onMessage` and nothing else); `onMessage` a message's id (`read_chats`, `read_new_events`; for mail, its id from `search` or `fetch`), replied to (or reacted to); `mentions` (`[{name, sender}]`: each `@name` in `text`, in its order, `sender` the sender id `read_chats` shows for that person in this chat); for mail only `from`, `subject`, `cc`. A feature the chat can't take is refused when you ask. Mark the one option that sends it `outgoing: true`: Life sends it exactly as shown when he picks that option alone (with his words added, or another option, nothing is sent), and `decision.answered` carries `send`, the sent message's id or its error. A failed send is never retried: ask a new card.",
  options:
    'An option is `{id, label}`, a label at most five words, the recommended one first. What his pick of it alone (no words of his added) does, at most one mark each: `outgoing: true`, it acts outside Life (sends, pays, books, deletes or changes something others see): with a `draft`, it sends it (`fetch("ask/draft")`). `ends: "step"` (`subject` one of its matter\'s open steps) or `ends: "matter"`, it means the step or the matter is done: his pick closes that step, or every open step of the matter, in Life, and `decision.answered` carries `end`, its error if it failed. `looks: true`, he says he did the step: Life looks for it done now (`doneSeenBy`, `fetch("ask/payment")`). `takes: "note"`, his pick comes with his words (`note`): nothing else is done with it. `onSilence` never names an `outgoing`, `ends`, `looks` or `takes` option: on silence nothing goes out, closes or is looked for.',
  payment: `A payment he makes (a transfer, a bill paid online): \`needs\` with the \`account\` (or a \`link\` to pay online), the \`amount\`, and a \`text\` for the reference; \`doneSeenBy: "payment"\`; options "I've paid" marked \`looks: true\` and "Drop it" (\`ends: "matter"\` when nothing else is left). On his pick of the \`looks\` option alone, Life looks in his accounts for money out of exactly that amount in that currency, booked on or after the card's day (never the holder's name: the bank gives none). Seen: the card ends and \`decision.answered\` carries \`doneSeen\` (\`state: "seen"\`, its \`eventId\`, read it with \`read_payments\`). Not found: the card is open again for him to check later, and you hear nothing. While the card is open, Life also looks every few minutes (a statement can come in days late): seen, the card ends with no answer of his, and \`decision.answered\` carries \`doneSeen\` and no \`answer\`. While payments are off in his settings, nothing is looked for: the option is a plain answer. Once it is paid, if the payee should hear it, ask the next card: a \`draft\` telling them it's paid (\`fetch("ask/draft")\`). Example: \`{"title":"Pay the dive course deposit","question":"Pay the deposit by Monday?","needs":[{"kind":"account","bank":"Kasikornbank","number":"012-3-45678-9","holder":"Blue Reef Diving Co., Ltd.","scheme":"th_account"},{"kind":"amount","value":4500,"currency":"THB"},{"kind":"text","label":"Reference","text":"DEP-12","copy":true}],"doneSeenBy":"payment","options":[{"id":"paid","label":"I've paid","looks":true},{"id":"drop","label":"Drop it"}],"deadline":"…","subject":"…"}\`.`,
};

const ASK_PAGE = /^ask\/([a-z_]+)$/;

/** Whether `id` is an ask page's (`ask/<name>`), which `fetch` opens. */
export const isAskPage = (id: string) => ASK_PAGE.test(id);

/** The page `fetch("ask/<name>")` opens: a part's rules, or a need kind's; else the pages there are. */
export function askPageOf(id: string) {
  const name = ASK_PAGE.exec(id)?.[1] ?? "";
  const page = Object.hasOwn(PAGES, name) ? PAGES[name] : needPageOf(name);
  return (
    page ??
    `(no page ask/${name}: ${[...Object.keys(PAGES), ...NEED_KINDS].map((p) => `ask/${p}`).join(", ")})`
  );
}

/**
 * What an agent gives `request_decision` (the connector's, the door's): an `Ask` less the desk's stamp, published loose
 * where the contract grows (`needs`, `doneSeenBy`, an option's marks, `plan`), so a new kind never changes the tool's
 * arguments; `requestDecision` checks the rest with `Ask`, and refuses what is not built yet. Or a withdrawal.
 */
export const DecisionRequest = Ask.omit({ agent: true })
  .partial()
  .extend({
    doneSeenBy: z.string().optional(),
    needs: z.array(z.looseObject({ kind: z.string() })).optional(),
    options: z
      .array(z.looseObject({ id: z.string(), label: z.string() }))
      .optional(),
    plan: z.array(z.looseObject({})).optional(),
    why: Withdrawal.shape.why.optional().describe("With `withdraw`: why"),
    withdraw: Withdrawal.shape.withdraw.optional(),
  });
