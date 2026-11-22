import { z } from "zod";

// The main session's wire (Ask Life, his decisions of 21 Nov 2026): what his app sends it, the lines it streams back
// and the answer it ends on, one of a closed list of kinds the phone draws natively. Read by the desk
// (`desk/main-session.ts`) and the connector alike.

/** What is on his screen, as refs only (never text or pixels): the tab, the thing open, up to 20 refs in view. */
export const MainSessionScreen = z
  .object({
    open: z.string().min(1).max(200).optional(),
    tab: z.string().min(1).max(40).optional(),
    visible: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .strict();
export type MainSessionScreen = z.infer<typeof MainSessionScreen>;

/** His ask: his words (none: he is on the Ask Life screen, so the session is kept warm), his screen, and the key that makes a retry ask once. */
export const MainSessionAsk = z
  .object({
    key: z.string().min(1).max(200).optional(),
    screen: MainSessionScreen.optional(),
    words: z.string().trim().min(1).max(8000).optional(),
  })
  .strict();
export type MainSessionAsk = z.infer<typeof MainSessionAsk>;

/**
 * What the session adds to its answer at its door (`answer`, its one tool): why and the refs it rests on, or, with
 * `answers`, the likely answers that make it a question. Its words are always its text after its last tool call.
 */
export const AnswerExtras = z
  .object({
    answers: z.array(z.string().trim().min(1).max(80)).min(2).max(4).optional(),
    sources: z.array(z.string().min(1).max(200)).max(5).optional(),
    why: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export type AnswerExtras = z.infer<typeof AnswerExtras>;

/**
 * What his phone shows with the answer (the main session's `show`, which changes no data): one `page` (a matter, a
 * person or organization, a project, an agent, by `id`), or a `list` of one tab (`matters` on Projects, `checks` on the
 * Inbox, `people` on People) cut to the rows `refs` names, in that order, under `label`, its words, until he closes it.
 * The session picks the rows from Life's own reads; each is checked when shown (`showProblemOf`).
 */
export const MainSessionShow = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().min(1).max(200),
      kind: z.literal("page"),
      page: z.enum(["agent", "matter", "person", "project"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("list"),
      label: z.string().trim().min(1).max(60),
      list: z.enum(["checks", "matters", "people"]),
      refs: z.array(z.string().min(1).max(200)).min(1).max(50),
    })
    .strict(),
]);
export type MainSessionShow = z.infer<typeof MainSessionShow>;

/**
 * What the main session did on a turn, by its door's acts, recorded by the door from what each act wrote (never declared
 * by the session): `done` (a correction, on matter `matter` when it named one), `agent` (his word about an agent, or his
 * words to it: its name and his words), `card` (a card asked as his: its id), `fix` (his complaint, received by the
 * caretaker).
 */
export type MainSessionAct =
  | { kind: "done"; matter?: string }
  | { agent: string; kind: "agent"; told: string }
  | { card: string; kind: "card" }
  | { kind: "fix" };

/**
 * The answer, one kind of a closed list the phone draws natively: `reply` (its words, a line of why, the refs it rests
 * on), `question` (its words, with likely answers he may tap), `error` (what failed; his words are kept on the phone),
 * and, when the turn acted, its last act's kind with its words (`MainSessionAct`; a question still wins: it waits on him).
 * Any kind but `error` may carry `show`, what his phone shows with it. `offline` is the phone's own state, never on the
 * wire.
 */
export type MainSessionAnswer =
  | ({ show?: MainSessionShow } & (
      | { kind: "reply"; sources?: string[]; why?: string; words: string }
      | { answers: string[]; kind: "question"; question: string }
      | (MainSessionAct & { words: string })
    ))
  | { kind: "error"; what: string };

/**
 * A streamed line before the answer: that it thinks, a tool call and its state, a chunk of its words (a `working` line
 * after words starts them again: the answer is its text after its last tool call), then `answer`.
 */
export type MainSessionLine =
  | { kind: "thinking" }
  | { id: string; kind: "working"; state: string; title: string }
  | { kind: "words"; text: string }
  | { answer: MainSessionAnswer; kind: "answer" };
