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

/** Text as compared: no accents, case or extra spaces. */
const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const NUMBER = /\d(?:[\d,\s]*\d)?(?:\.\d+)?/g;
const GROUPING = /[,\s]+/g;

/** Every number written in `text`, a digit group's commas and spaces read as thousands ("4,820" is 4820), or apart. */
const numbersIn = (text: string) =>
  new Set(
    (text.match(NUMBER) ?? []).flatMap((n) => [
      Number(n.replace(GROUPING, "")),
      ...n.split(GROUPING).map(Number),
    ])
  );

/**
 * Why a block's written values are not all in `source`, the text of its `from` (none when they are): each number must be
 * one the source writes, each name or line must be in it as written (no accents, case or spacing), and a table's
 * `total` must be the sum of its last column.
 */
export function valueProblemOf(
  { body, kind }: AnswerBlock,
  source: string
): string | undefined {
  const numbers = numbersIn(source);
  const text = plain(source);
  const missing = (v: string | number) =>
    typeof v === "number" ? !numbers.has(v) : !text.includes(plain(v));
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

const OPEN = /^```life:([a-z]+)\s*$/;
const CLOSE = /^```\s*$/;

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
  let fence: { body: string[]; kind: string } | null = null;
  const take = (whole: string) => {
    if (fence) {
      if (CLOSE.test(whole)) {
        on.block({ json: fence.body.join("\n"), kind: fence.kind });
        fence = null;
      } else {
        fence.body.push(whole);
      }
      return;
    }
    const open = OPEN.exec(whole);
    if (open) {
      fence = { body: [], kind: open[1] as string };
    } else {
      on.words(`${whole}\n`);
    }
  };
  return {
    end() {
      if (fence) {
        on.block({ json: fence.body.join("\n"), kind: fence.kind }, true);
      } else if (line) {
        on.words(line);
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
          on.words(`${part}\n`);
        }
        line = "";
        isLineStart = true;
      }
      if (fence || (isLineStart && (line + rest).startsWith("`"))) {
        line += rest;
      } else if (isLineStart && line + rest === "") {
        // nothing yet on this line
      } else {
        on.words(line + rest);
        line = "";
        isLineStart = false;
      }
    },
  };
}
