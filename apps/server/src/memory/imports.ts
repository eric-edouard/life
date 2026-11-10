import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { appendJsonl, rowsOf } from "../core/files";
import { settings } from "../core/settings";
import { stamp } from "../models/llm";
import type { MadeBy } from "../records/fields";
import { Imported } from "../records/observation";
import {
  type Conversation,
  FORMATS,
  formatOf,
  importOf,
  parsedExport,
} from "../sources/assistants";
import { IMPORTED, keptConversations } from "./ledger";
import { loadTruth } from "./read-truth";
import { begin, checkedEntries, chunks, inBatches, meContext } from "./run";
import { spareQuota } from "./schedule";
import { clip } from "./units";
import { localDate, wall } from "./zones";

// `bun life import <folder> [--dry]`: his claude.ai or ChatGPT export, once (~/Life/docs/
// claude-import-scope-2026-10-21.md). The export is pruned by code (`pruned`), copied into his data, and each
// conversation is judged once by the fast model from the start of his messages: about his life, or only work with the
// assistant (memory/imported.jsonl). The kept ones are a source like any other (`sources/assistants.ts`): collection
// makes their older days searchable without historical model work.

const IMPORT_PROMPT = "import.v1";
const PER_CALL = 10;
/** What the model reads of a conversation: its title and the start of his messages. */
const GIST = 3000;

/** An export folder's `conversations.json`: which assistant's it is and its conversations, pruned. */
export function readExport(folder: string) {
  const file = join(folder, "conversations.json");
  const json: unknown = JSON.parse(readFileSync(file, "utf8"));
  const source = formatOf(json);
  if (!source) {
    throw new Error(`${file} is neither a claude.ai nor a ChatGPT export`);
  }
  return { ...parsedExport(source, json), file, source };
}

const gist = (c: Conversation) =>
  clip(c.messages.map((m) => m.text).join("\n"), GIST);

/** What an import would read: conversations, his kept messages, their days, and what the judging would read. */
export function summaryOf(all: number, conversations: Conversation[]) {
  const messages = conversations.flatMap((c) => c.messages);
  const days = [...new Set(messages.map((m) => localDate(m.at)))].sort();
  return {
    calls: Math.ceil(conversations.length / PER_CALL),
    chars: messages.reduce((n, m) => n + m.text.length, 0),
    conversations: { all, kept: conversations.length },
    days: days.length,
    from: days[0],
    gistChars: conversations.reduce((n, c) => n + gist(c).length, 0),
    messages: messages.length,
    to: days.at(-1),
  };
}

/** `import --dry`: what importing `folder` would read, with no copy and no model call. */
export function dryRun(folder: string) {
  const { all, conversations, source } = readExport(folder);
  return { source, ...summaryOf(all, conversations) };
}

const Entry = z.object({
  id: z.string(),
  keep: z.boolean(),
  why: z.string().min(1),
});

/** The model's reply for one call: a line for each conversation asked about, once; anything else is counted invalid. */
export function parseJudged(
  reply: unknown,
  asked: Set<string>,
  ctx: { at: string; madeBy: MadeBy; source: string }
) {
  const list = z
    .object({ conversations: z.array(z.unknown()) })
    .parse(reply).conversations;
  const { entries, invalid } = checkedEntries(
    list,
    Entry,
    (e) => e.id,
    (id) => asked.has(id)
  );
  const records = entries.map(
    (e): Imported => ({
      at: ctx.at,
      conversation: `${ctx.source}:${e.id}`,
      keep: e.keep,
      madeBy: ctx.madeBy,
      schemaVersion: 1,
      why: clip(e.why, 300),
    })
  );
  return { invalid, records };
}

/**
 * Copies the export into his data and judges each conversation not judged yet under this prompt. A different export
 * of the same assistant is refused: the copy is the only source of its units' words.
 */
export async function importExport(folder: string) {
  const { all, conversations, file, source } = readExport(folder);
  const to = importOf(source);
  if (existsSync(to) && !readFileSync(to).equals(readFileSync(file))) {
    throw new Error(
      `${to} holds another ${FORMATS[source].label} export already`
    );
  }
  const engine = settings().backfillEngine;
  if (!engine) {
    throw new Error("imports are off: set backfillEngine in settings first");
  }
  await spareQuota(engine);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(file, to);
  const step = await begin(
    "import",
    "fast",
    { prompt: IMPORT_PROMPT, source },
    engine
  );
  const unjudged = () => {
    const judged = new Set(
      rowsOf(IMPORTED, Imported)
        .filter((i) => i.madeBy.prompt === IMPORT_PROMPT)
        .map((i) => i.conversation)
    );
    return conversations.filter((c) => !judged.has(`${source}:${c.id}`));
  };
  const due = unjudged();
  const ctx = {
    at: step.now.toISOString(),
    madeBy: stamp(step.llm, IMPORT_PROMPT, step.run),
    source,
  };
  const context = meContext(await loadTruth());
  let invalid = 0;
  // One bad call costs only its conversations: they are asked again on the next run.
  await inBatches(chunks(due, PER_CALL), step.dir, (batch, dir) =>
    step.attempt(async () => {
      const json = await step.ask({
        context,
        dir,
        input: {
          assistant: FORMATS[source].label,
          conversations: batch.map((c) => ({
            id: c.id,
            text: gist(c),
            title: c.title,
          })),
        },
        prompt: IMPORT_PROMPT,
      });
      const checked = parseJudged(json, new Set(batch.map((c) => c.id)), ctx);
      // Written as each call ends: a stopped run resumes from them.
      appendJsonl(IMPORTED, Imported, checked.records);
      invalid += checked.invalid;
    })
  );
  // Model eligibility counts kept conversations; search collects every pruned owner message.
  const kept = keptConversations();
  const days = summaryOf(
    all,
    conversations.filter((c) => kept.has(`${source}:${c.id}`))
  );
  const read = summaryOf(all, conversations);
  const utcDays = [
    ...new Set(
      conversations.flatMap((c) => c.messages.map((m) => wall(m.at, "UTC").day))
    ),
  ].sort();
  return step.end({
    asked: due.length,
    invalid,
    kept: days.conversations.kept,
    read,
    source,
    units: { days: utcDays.length, from: utcDays[0], to: utcDays.at(-1) },
    // A conversation a failed call left unjudged reads as not kept: the same import retries it.
    unjudged: unjudged().length,
  });
}
