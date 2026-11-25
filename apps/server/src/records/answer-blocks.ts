import { z } from "zod";

// The main session's answer (Life v4): its Markdown, with Life's own components as fenced blocks, ```life:<kind>
// around the component's JSON. One catalog, one splitter, one check of written values: the desk checks each block when
// its fence closes (`desk/main-session.ts`) and the phone draws only those that pass. Refs are `life:<ref>`, the one ref
// grammar (`parseRef`). No style, and nothing in a block acts but Life's own items.

/** The catalog's version: the phone says which it draws (`MainSessionAsk.catalog`); a kind newer than that is dropped. */
const CATALOG = 1;

const LIFE = "life:";
const LifeRef = z.string().startsWith(LIFE).max(300);
const Cell = z.union([z.string().trim().min(1).max(200), z.number()]);

/** Each component's body, by kind, with the catalog version it came in. */
const BLOCKS = {
  /** A paper as it was sent: its key lines as written, checked against `from`. */
  document: {
    body: z
      .object({
        from: LifeRef,
        kind: z.enum(["receipt", "booking", "ticket", "invoice", "other"]),
        lines: z.array(Cell).min(1).max(8),
        title: z.string().trim().min(1).max(120),
        total: Cell.optional(),
      })
      .strict(),
    since: 1,
  },
  /** Things that wait: asks, matters, their steps, drawn live in their states. */
  items: { body: z.array(LifeRef).min(1).max(8), since: 1 },
  /** Words for someone in front of him, in their language (`lang`), with his own (`mine`). */
  phrase: {
    body: z
      .object({
        lang: z.string().min(2).max(20),
        mine: z.string().trim().min(1).max(400),
        text: z.string().trim().min(1).max(280),
        to: z.string().trim().min(1).max(80).optional(),
      })
      .strict(),
    since: 1,
  },
  /** Photos Life holds, as file refs. */
  pictures: { body: z.array(LifeRef).min(1).max(20), since: 1 },
  /** Somewhere to go, from the web: its name and address (the phone opens the maps). */
  place: {
    body: z
      .object({
        address: z.string().trim().min(1).max(300),
        name: z.string().trim().min(1).max(120),
      })
      .strict(),
    since: 1,
  },
  /** Life's question's likely answers, each sent as his words on a tap; `recommended`, one of them, drawn first. */
  question: {
    body: z
      .object({
        answers: z.array(z.string().trim().min(1).max(80)).min(2).max(4),
        recommended: z.string().trim().min(1).max(80).optional(),
      })
      .strict()
      .refine((q) => !q.recommended || q.answers.includes(q.recommended), {
        message: "`recommended` is one of `answers`",
      }),
    since: 1,
  },
  /** Life's settings, drawn by the phone (`keys`: only those; none: all). */
  settings: {
    body: z
      .object({ keys: z.array(z.string().min(1).max(60)).max(20).optional() })
      .strict(),
    since: 1,
  },
  /** Values in rows, each checked against `from`; `total`, the sum of the last column. */
  table: {
    body: z
      .object({
        columns: z.array(z.string().trim().min(1).max(40)).min(1).max(4),
        from: LifeRef,
        rows: z.array(z.array(Cell).min(1).max(4)).min(1).max(40),
        total: z.number().optional(),
      })
      .strict()
      .refine((t) => t.rows.every((r) => r.length === t.columns.length), {
        message: "every row has one cell per column",
      }),
    since: 1,
  },
} as const;
export type BlockKind = keyof typeof BLOCKS;

/** One block as checked: its kind and body. */
export interface AnswerBlock {
  body: unknown;
  kind: BlockKind;
}

/** A fenced block as written: its kind and the JSON between its fences. */
interface FencedBlock {
  json: string;
  kind: string;
}

/** The block a fence holds, or why it is not one: an unknown kind, a kind newer than `catalog`, bad JSON or shape. */
export function parseBlock(
  f: FencedBlock,
  catalog = CATALOG
): AnswerBlock | { error: string } {
  const spec = (BLOCKS as Record<string, (typeof BLOCKS)[BlockKind]>)[f.kind];
  if (!spec || spec.since > catalog) {
    return { error: "kind" };
  }
  let json: unknown;
  try {
    json = JSON.parse(f.json);
  } catch {
    return { error: "json" };
  }
  const body = spec.body.safeParse(json);
  return body.success
    ? { body: body.data, kind: f.kind as BlockKind }
    : { error: "shape" };
}

/** The source a block's written values are checked against, if any (a ref, `life:` dropped). */
export const blockSourceOf = ({ body, kind }: AnswerBlock) =>
  kind === "table" || kind === "document"
    ? (body as { from: string }).from.slice(LIFE.length)
    : undefined;

/** The refs a block names (`life:` dropped): what must open for it to be drawn. */
export function blockRefsOf(b: AnswerBlock): string[] {
  if (b.kind === "items" || b.kind === "pictures") {
    return (b.body as string[]).map((r) => r.slice(LIFE.length));
  }
  const from = blockSourceOf(b);
  return from ? [from] : [];
}

/** The edges of a word that are not part of it: punctuation and signs around it ("(4,820).", "#12", "฿4,820"). */
const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
/** A number as written: digits, comma-grouped by thousands or not, with decimals. */
const NUMBER = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const COMMAS = /,/g;
const SPACES = /\s+/;

/** A text's words as compared: no accents or case, each without the punctuation around it. */
const wordsOf = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(SPACES)
    .map((w) => w.replace(EDGES, ""))
    .filter(Boolean);

/** The number a word writes ("4,820" is 4820), if it is one whole. */
const numberOf = (word: string) =>
  NUMBER.test(word) ? Number(word.replace(COMMAS, "")) : undefined;

/**
 * Why a block's written values are not all in `source`, the text of its `from` (none when they are): each number must be
 * one the source writes, each name or line must be in it as written (no accents, case or spacing), and a table's
 * `total` must be the sum of its last column.
 */
export function valueProblemOf(
  { body, kind }: AnswerBlock,
  source: string
): string | undefined {
  const words = wordsOf(source);
  const numbers = new Set(words.flatMap((w) => numberOf(w) ?? []));
  const text = ` ${words.join(" ")} `;
  // A number, written as one or as a cell's whole text, must be one the source writes whole; any other text must be
  // in the source as whole words, in order.
  const missing = (v: string | number) => {
    const n = typeof v === "number" ? v : numberOf(wordsOf(v).join(" "));
    return n === undefined
      ? !text.includes(` ${wordsOf(String(v)).join(" ")} `)
      : !numbers.has(n);
  };
  if (kind === "table") {
    const t = body as z.infer<(typeof BLOCKS)["table"]["body"]>;
    const bad = t.rows.flat().find(missing);
    if (bad !== undefined) {
      return `${bad} is not in its source`;
    }
    const last = t.rows.map((r) => r.at(-1));
    const sum = last.reduce<number>(
      (s, v) => s + (typeof v === "number" ? v : 0),
      0
    );
    return t.total === undefined || t.total === sum
      ? undefined
      : `its total ${t.total} is not ${sum}`;
  }
  if (kind === "document") {
    const d = body as z.infer<(typeof BLOCKS)["document"]["body"]>;
    const bad = [
      d.title,
      ...d.lines,
      ...(d.total === undefined ? [] : [d.total]),
    ].find(missing);
    return bad === undefined ? undefined : `${bad} is not in its source`;
  }
}

/** A fence opening a `life:` block: up to 3 spaces, three or more backticks or tildes, then `life:<kind>` and anything after. */
const OPEN = /^ {0,3}(`{3,}|~{3,})\s*life:(\S*)/;
/** A line that may still become a fence's opening: empty, up to 3 spaces, or fence characters after them. */
const MAY_OPEN = /^ {0,3}(?:[`~]|$)/;
/** A `life:` fence's marker anywhere in a line: never shown as words. */
const LIFE_FENCE = /(`{3,}|~{3,})\s*life:/;

/**
 * Splits a stream of Markdown into its words and its fenced blocks as they come: `words` hears the text outside a
 * `life:` fence (a line that may open one is held until it ends), `block` each fence once it closes. `end` flushes; a
 * fence never closed is handed to `block` with `isOpen` (a miss).
 */
export function blockSplitter(on: {
  block: (f: FencedBlock, isOpen?: true) => void;
  words: (text: string) => void;
}) {
  let line = "";
  let isLineStart = true;
  let fence: { body: string[]; close: RegExp; kind: string } | null = null;
  /** A line of words, unless it holds a `life:` fence's marker (a block never passes unchecked). */
  const words = (text: string) => {
    if (!LIFE_FENCE.test(text)) {
      on.words(text);
    }
  };
  const take = (whole: string) => {
    if (fence) {
      if (fence.close.test(whole)) {
        on.block({ json: fence.body.join("\n"), kind: fence.kind });
        fence = null;
      } else {
        fence.body.push(whole);
      }
      return;
    }
    const open = OPEN.exec(whole);
    if (open) {
      const [, marks = "```", kind = ""] = open;
      // Closed by the same character, at least as many, alone on its line.
      const close = new RegExp(`^ {0,3}\\${marks[0]}{${marks.length},}\\s*$`);
      fence = { body: [], close, kind };
    } else {
      words(`${whole}\n`);
    }
  };
  return {
    end() {
      if (fence) {
        on.block({ json: fence.body.join("\n"), kind: fence.kind }, true);
      } else if (line) {
        words(line);
      }
      line = "";
      fence = null;
      isLineStart = true;
    },
    push(chunk: string) {
      const parts = chunk.split("\n");
      const rest = parts.pop() ?? "";
      for (const part of parts) {
        if (fence || isLineStart) {
          take(line + part);
        } else {
          words(`${part}\n`);
        }
        line = "";
        isLineStart = true;
      }
      if (fence || (isLineStart && MAY_OPEN.test(line + rest))) {
        line += rest;
      } else {
        words(line + rest);
        line = "";
        isLineStart = false;
      }
    },
  };
}
