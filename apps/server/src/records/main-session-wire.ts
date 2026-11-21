import { z } from "zod";

// The main session's wire (Tell Life, his decisions of 21 Nov 2026): what his app sends it, the lines it streams back
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

/** His ask: his words (none: he is on the Tell Life screen, so the session is kept warm), his screen, and the key that makes a retry ask once. */
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
 * The answer, one kind of a closed list the phone draws natively: `reply` (its words, a line of why, the refs it rests
 * on), `question` (its words, with likely answers he may tap) and `error` (what failed; his words are kept on the phone).
 * The design's act kinds (`done`, `agent`, `card`, `fix`) come with the acts that make them; `offline` is the phone's
 * own state, never on the wire.
 */
export type MainSessionAnswer =
  | { kind: "reply"; sources?: string[]; why?: string; words: string }
  | { answers: string[]; kind: "question"; question: string }
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
