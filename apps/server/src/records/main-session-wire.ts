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
 * The answer kinds of this slice: `reply` (its words) and `error` (what failed; his words are kept on the phone). The
 * rest of the design's list (`done`, `fix`, `agent`, `card`, `question`) comes with what makes each; `offline` is the
 * phone's own state, never on the wire.
 */
export type MainSessionAnswer =
  | { kind: "reply"; words: string }
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
