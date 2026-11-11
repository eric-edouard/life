import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { appendJsonl, rowsOf } from "../core/files";
import { digest } from "../core/hash";
import { settings } from "../core/settings";
import { stamp } from "../models/llm";
import type { MadeBy } from "../records/fields";
import { Imported } from "../records/observation";
import {
  COPY,
  type Conversation,
  exportCopiesOf,
  exportsDir,
  FORMATS,
  formatOf,
  kept,
  latestVersions,
  parsedExport,
  pruned,
} from "../sources/assistants";
import { IMPORTED, keptConversations, latestBy } from "./ledger";
import { loadTruth } from "./read-truth";
import { begin, checkedEntries, chunks, inBatches, meContext } from "./run";
import { spareQuota } from "./schedule";
import { clip } from "./units";
import { localDate, wall } from "./zones";

// `bun life import <folder> [--dry]`: his claude.ai or ChatGPT export (~/Life/docs/claude-import-scope-2026-10-21.md),
// a newer one too. The export is kept in his data as a copy of its own (`sources/assistants.ts`), never replacing or
// merging an older one, and each conversation is judged by the fast model from the start of his messages: about his
// life, or only work with the assistant (memory/imported.jsonl). It is judged again only when what the model reads of
// it changed. The kept ones are a source like any other: collection makes their older days searchable without
// historical model work.

const IMPORT_PROMPT = "import.v1";
const PER_CALL = 10;
/** What the model reads of a conversation: its title and the start of his messages. */
const GIST = 3000;

/** A file of a ChatGPT export too large for one: `conversations-000.json`, `-001`… */
const PART = /^conversations-\d+\.json$/;

/**
 * An export folder's conversations: which assistant's they are, his messages only, and the one file kept of them (`copy`).
 * A large ChatGPT export has no `conversations.json` but parts (`PART`): read by their number and joined.
 */
export function readExport(folder: string) {
  const whole = join(folder, "conversations.json");
  const parts = existsSync(whole)
    ? []
    : readdirSync(folder)
        .filter((f) => PART.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const read = (file: string): unknown =>
    JSON.parse(readFileSync(file, "utf8"));
  const json = parts.length
    ? parts.flatMap((f) => read(join(folder, f)))
    : read(whole);
  const source = formatOf(json);
  if (!source) {
    throw new Error(`${folder} is neither a claude.ai nor a ChatGPT export`);
  }
  return {
    conversations: parsedExport(source, json),
    copy: parts.length
      ? Buffer.from(JSON.stringify(json))
      : readFileSync(whole),
    source,
  };
}

const gist = (c: Conversation) =>
  clip(
    c.messages
      .filter((m) => kept(m.text))
      .map((m) => m.text)
      .join("\n"),
    GIST
  );

/** What the model reads of a conversation, as a hash: it is judged again when this changes. */
const gistHash = (c: Conversation) =>
  digest("sha256", `${c.title}\n${gist(c)}`, 12);

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

const Entry = z.object({
  id: z.string(),
  keep: z.boolean(),
  why: z.string().min(1),
});

/**
 * The model's reply for one call: a line for each conversation asked about (`asked`: its id and the hash of what the
 * model read), once; anything else is counted invalid.
 */
export function parseJudged(
  reply: unknown,
  asked: Map<string, string>,
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
      hash: asked.get(e.id),
      keep: e.keep,
      madeBy: ctx.madeBy,
      schemaVersion: 1,
      why: clip(e.why, 300),
    })
  );
  return { invalid, records };
}

const sameMessages = (a: Conversation | undefined, b: Conversation) =>
  a?.messages.length === b.messages.length &&
  b.messages.every(
    (m, i) => m.id === a.messages[i]?.id && m.text === a.messages[i]?.text
  );

/**
 * What importing an export would do: its conversations as the memory would read them after (`merged`, each at its
 * latest version), the ones whose latest version it changes (`changed`, with the version before), and the ones due a
 * judgment (`due`): never judged, or what the model reads of them changed since. A line from before `hash` stands for
 * the conversation's first version.
 */
function planOf(
  source: keyof typeof FORMATS,
  conversations: Conversation[],
  copy: Buffer
) {
  const copies = exportCopiesOf(source);
  const have = copies.some(
    (c) =>
      statSync(c.path).size === copy.length && readFileSync(c.path).equals(copy)
  );
  const before = latestVersions(copies);
  const after = have
    ? before
    : latestVersions([
        ...copies,
        {
          conversations,
          path: "",
          updatedAt:
            conversations
              .map((c) => c.updatedAt)
              .sort()
              .at(-1) ?? "",
        },
      ]);
  const merged = pruned([...after.values()].map((v) => v.latest));
  const changed = [...after]
    .filter(([id, v]) => !sameMessages(before.get(id)?.latest, v.latest))
    .map(([id, v]) => ({ before: before.get(id)?.latest, now: v.latest }));
  return {
    after,
    changed,
    // Recomputed after the judging, from the lines it wrote.
    due: () => {
      const lines = latestBy(
        rowsOf(IMPORTED, Imported).filter(
          (i) => i.madeBy.prompt === IMPORT_PROMPT
        ),
        (i) => i.conversation
      );
      return merged.filter((c) => {
        const line = lines.get(`${source}:${c.id}`);
        const v = after.get(c.id) as {
          first: Conversation;
          latest: Conversation;
        };
        if (!line) {
          return true;
        }
        if (line.hash) {
          return line.hash !== gistHash(v.latest);
        }
        return v.first !== v.latest && gistHash(v.first) !== gistHash(v.latest);
      });
    },
    have,
    merged,
  };
}

/** `import --dry`: what importing `folder` would read and judge, and what is new in it; no copy, no model call. */
export function dryRun(folder: string) {
  const { conversations, copy, source } = readExport(folder);
  const plan = planOf(source, conversations, copy);
  const due = plan.due();
  const words = (c: Conversation | undefined) =>
    new Set(c?.messages.map((m) => `${m.id} ${m.text}`));
  return {
    new: {
      changed: plan.changed.filter((c) => c.before).length,
      conversations: plan.changed.filter((c) => !c.before).length,
      messages: plan.changed.reduce((n, { before, now }) => {
        const had = words(before);
        return (
          n + now.messages.filter((m) => !had.has(`${m.id} ${m.text}`)).length
        );
      }, 0),
    },
    source,
    ...summaryOf(plan.after.size, due),
  };
}

/** The UTC days of a conversation's kept messages. */
const daysOf = (c: Conversation | undefined) =>
  (c?.messages ?? []).flatMap((m) =>
    kept(m.text) ? [wall(m.at, "UTC").day] : []
  );

/**
 * Keeps the export as a copy of its own (unless these very bytes are kept already) and judges each conversation due.
 * Collection covers the days of the conversations it changed or judged again.
 */
export async function importExport(folder: string) {
  const { conversations, copy, source } = readExport(folder);
  const plan = planOf(source, conversations, copy);
  const engine = settings().backfillEngine;
  if (!engine) {
    throw new Error("imports are off: set backfillEngine in settings first");
  }
  await spareQuota(engine);
  if (!plan.have) {
    const dir = exportsDir(source);
    mkdirSync(dir, { recursive: true });
    const name = readdirSync(dir).some((f) => COPY.test(f))
      ? `conversations.${digest("sha256", copy, 12)}.json`
      : "conversations.json";
    writeFileSync(join(dir, `${name}.tmp`), copy);
    renameSync(join(dir, `${name}.tmp`), join(dir, name));
  }
  const step = await begin(
    "import",
    "fast",
    { prompt: IMPORT_PROMPT, source },
    engine
  );
  const due = plan.due();
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
      const checked = parseJudged(
        json,
        new Map(
          batch.map((c) => [
            c.id,
            gistHash((plan.after.get(c.id) as { latest: Conversation }).latest),
          ])
        ),
        ctx
      );
      // Written as each call ends: a stopped run resumes from them.
      appendJsonl(IMPORTED, Imported, checked.records);
      invalid += checked.invalid;
    })
  );
  // Model eligibility counts kept conversations; search collects every pruned owner message.
  const keptKeys = keptConversations();
  const days = [
    ...new Set([
      ...plan.changed.flatMap((c) => [...daysOf(c.before), ...daysOf(c.now)]),
      ...due.flatMap(daysOf),
    ]),
  ].sort();
  return step.end({
    asked: due.length,
    invalid,
    kept: plan.merged.filter((c) => keptKeys.has(`${source}:${c.id}`)).length,
    read: summaryOf(plan.after.size, plan.merged),
    source,
    units: { days: days.length, from: days[0], to: days.at(-1) },
    // A conversation a failed call left unjudged reads as not kept: the same import retries it.
    unjudged: plan.due().length,
  });
}
