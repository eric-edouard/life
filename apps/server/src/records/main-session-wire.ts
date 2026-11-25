import { z } from "zod";
import type { BlockKind } from "./answer-blocks";

// The main session's wire (Ask Life, his decisions of 21 Nov 2026; Life v4): what his app sends it, the lines it streams
// back and the answer it ends on: Markdown with Life's own blocks (`answer-blocks.ts`). Read by the desk
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

/** A reaction: one emoji. */
const Reaction = z.string().min(1).max(16);

/**
 * His ask (`MainSessionAskFields`, its fields; `MainSessionAsk`, checked whole): his words, his screen, the catalog version his phone draws, and the key that makes a retry ask once; `tap`: his words are what he tapped (a quick edit's label, a question's answer, an offer), so a redraft on them is `edit:tap`. Or, with
 * no words: `stop` (the running ask cancelled), `react` (his reaction to one of Life's entries: kept on it, never his
 * word for an act, and it starts no turn), or nothing (he is on the screen: the session is kept warm).
 */
export const MainSessionAskFields = z
  .object({
    catalog: z.number().int().min(1).optional(),
    key: z.string().min(1).max(200).optional(),
    react: z
      .object({ entry: z.number().int().min(1), with: Reaction })
      .strict()
      .optional(),
    screen: MainSessionScreen.optional(),
    stop: z.literal(true).optional(),
    tap: z.literal(true).optional(),
    words: z.string().trim().min(1).max(8000).optional(),
  })
  .strict();
export const MainSessionAsk = MainSessionAskFields.refine(
  (a) => !((a.words && (a.react || a.stop)) || (a.react && a.stop)),
  {
    message: "`words`, `react` and `stop` go one at a time",
  }
);
export type MainSessionAsk = z.infer<typeof MainSessionAsk>;

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
/** Each kind of act, once: a kind added to `MainSessionAct` without its entry here does not compile. */
const ACTS: Record<MainSessionAct["kind"], true> = {
  agent: true,
  card: true,
  done: true,
  fix: true,
};
export const MAIN_SESSION_ACT_KINDS = Object.keys(
  ACTS
) as MainSessionAct["kind"][];

/**
 * The answer: `reply`, its thread entry (`entry`), its Markdown (`text`, the blocks that passed their checks left in,
 * any other gone), the refs it cites, its acts in order, and Life's reaction to his words, if any; or `error` (what
 * failed; his words are kept on the phone).
 */
export type MainSessionAnswer =
  | {
      acts: MainSessionAct[];
      entry: number;
      kind: "reply";
      reaction?: string;
      refs: string[];
      text: string;
    }
  | { entry?: number; kind: "error"; what: string };

/**
 * A streamed line before the answer: that it thinks, a step (`verb` and `what`, written by code from the tool it calls),
 * a chunk of its words, a block once checked, Life's reaction to his words (the eyes when his ask waits its turn or work
 * is handed on); a `step` after words starts them, and the blocks, again: the answer is its text after its last tool
 * call. Then `answer`.
 */
export type MainSessionLine =
  | { kind: "thinking" }
  | { kind: "step"; verb: string; what: string }
  | { kind: "words"; text: string }
  | { block: unknown; kind: "block"; type: BlockKind }
  | { kind: "reaction"; with: string }
  | { answer: MainSessionAnswer; kind: "answer" };
/** Each kind of line, once: a kind added to `MainSessionLine` without its entry here does not compile. */
const LINES: Record<MainSessionLine["kind"], true> = {
  answer: true,
  block: true,
  reaction: true,
  step: true,
  thinking: true,
  words: true,
};
export const MAIN_SESSION_LINE_KINDS = Object.keys(
  LINES
) as MainSessionLine["kind"][];
