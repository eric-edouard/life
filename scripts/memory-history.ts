// `bun scripts/memory-history.ts <person> [--run]`: experimental history, never a live memory layer.
// Without --run, count calls and a token ceiling only. Never print names, messages or model output.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readJson, writeJson } from "@life/server/src/core/files";
import { OWNER_DATA_DIR } from "@life/server/src/core/paths";
import { directOf, readWithPeople } from "@life/server/src/memory/closeness";
import { batchesOf, charsOf } from "@life/server/src/memory/exchanges";
import { locate } from "@life/server/src/memory/observe";
import {
  ended,
  inBatches,
  inputsOf,
  metered,
} from "@life/server/src/memory/run";
import { readPeople } from "@life/server/src/memory/who";
import { batchLines } from "@life/server/src/memory/words";
import { localDate } from "@life/server/src/memory/zones";
import {
  askOnce,
  CHARS_PER_TOKEN,
  llmFor,
  promptText,
  stamp,
} from "@life/server/src/models/llm";
import type { SourceEvent } from "@life/server/src/records/source";
import { z } from "zod";

const MONTH_PROMPT = "memory-history-month.v0";
const STORY_PROMPT = "memory-history-story.v0";
const KEPT = join(OWNER_DATA_DIR, "docs/memory-rework/history");
// A character cap makes the later story's input ceiling finite before the summaries exist.
const SUMMARY_CHARS = 6000;
const WORDS = /\s+/;
const QUOTES = /"([^"\n]+)"|“([^”\n]+)”/g;
const proseOf = (words: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((s) => s.split(WORDS).length <= words);
const Month = z.object({
  month: z.string(),
  summary: proseOf(150).max(SUMMARY_CHARS),
});
const Story = z.object({ story: proseOf(600) });
type Month = z.infer<typeof Month>;
type Call = ReturnType<typeof historyCallsOf>[number];
interface Wording {
  month: string;
  story: string;
}

/** Each local month's exchanges, packed by the shared size rule and shown by the shared line renderer. */
export function historyCallsOf(
  messages: SourceEvent[],
  name: string,
  wording: string
) {
  return [...Map.groupBy(messages, (e) => localDate(e.at).slice(0, 7))]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([month, list]) =>
      batchesOf(list).map((batch) => {
        const { lines } = batchLines(batch, (e) => (e.fromMe ? "me" : name));
        const input = { lines, month, with: name };
        return { input, key: inputsOf(wording, input) };
      })
    );
}

function readKept<T>(dir: string, key: string, schema: z.ZodType<T>) {
  const checked = schema.safeParse(
    readJson<{ reply: unknown }>(join(dir, `${key}.json`))?.reply
  );
  return checked.success ? checked.data : undefined;
}

// A quote is checked as every quote in Life is (`locate`: accents, case, quote marks and spacing aside); one too
// short to check, or a phrase in quotation marks that is no quote, does not fail the month.
const monthSchemaOf = (c: Call) =>
  Month.extend({ month: z.literal(c.input.month) }).refine(({ summary }) => {
    const quotes = [...summary.matchAll(QUOTES)].map((m) => m[1] ?? m[2] ?? "");
    return quotes.some((quote) =>
      quote.length >= 8
        ? locate(quote, c.input.lines) !== null
        : c.input.lines.some((line) => line.includes(quote))
    );
  }, "summary needs at least one quote found in the month's lines");

/** Several batches of one month stay in their original order, joined into that month's summary. */
function storyInputOf(calls: Call[], replies: Month[]) {
  return {
    months: [...Map.groupBy(replies, (r) => r.month)].map(([month, list]) => ({
      month,
      summary: list.map((r) => r.summary).join("\n\n"),
    })),
    with: calls[0]?.input.with,
  };
}

/** Outstanding calls and their input token ceiling, including the later story input and JSON escaping. */
export function countsOf(calls: Call[], wording: Wording, dir: string) {
  const replies = calls.map((c) => readKept(dir, c.key, monthSchemaOf(c)));
  const pending = calls.filter((_, i) => !replies[i]);
  // Every character can take six JSON characters when escaped; actual prose normally takes far less.
  const bounded = replies.map(
    (r, i) =>
      r ?? {
        month: calls[i]?.input.month ?? "",
        summary: "\u0000".repeat(SUMMARY_CHARS),
      }
  );
  const input = storyInputOf(calls, bounded);
  const isStoryKept =
    pending.length === 0 &&
    !!readKept(dir, inputsOf(wording.story, input), Story);
  const chars =
    pending.reduce(
      (n, c) => n + wording.month.length + JSON.stringify(c.input).length,
      0
    ) +
    (isStoryKept || calls.length === 0
      ? 0
      : wording.story.length + JSON.stringify(input).length);
  return {
    calls: pending.length + Number(calls.length > 0 && !isStoryKept),
    months: new Set(calls.map((c) => c.input.month)).size,
    tokensAtMost: Math.ceil(chars / CHARS_PER_TOKEN),
  };
}

/** Only valid replies are kept; failed calls leave completed months available for the next run. */
export async function readHistory(
  calls: Call[],
  wording: Wording,
  o: {
    dir: string;
    llm: ReturnType<typeof llmFor>;
    run: string;
    ask?: typeof askOnce;
  }
) {
  if (calls.length === 0) {
    throw new Error("no one-to-one messages to read");
  }
  const ask = o.ask ?? askOnce;
  async function readReply<T>(
    prompt: string,
    text: string,
    input: unknown,
    schema: z.ZodType<T>
  ) {
    const key = inputsOf(text, input);
    const kept = readKept(o.dir, key, schema);
    if (kept) {
      return kept;
    }
    const reply = schema.parse(
      await ask({
        dir: join(o.dir, "calls", key),
        input,
        llm: o.llm,
        prompt,
        run: o.run,
      })
    );
    writeJson(join(o.dir, `${key}.json`), {
      input,
      madeBy: stamp(o.llm, prompt, o.run),
      reply,
    });
    return reply;
  }
  const replies = new Map<string, Month>();
  let failed = 0;
  await inBatches(calls, join(o.dir, "batches"), async (c) => {
    try {
      replies.set(
        c.key,
        await readReply(MONTH_PROMPT, wording.month, c.input, monthSchemaOf(c))
      );
    } catch {
      failed += 1;
    }
  });
  // The story is told from the months that passed; the ones that did not are counted, and asked again next run.
  const kept = calls.filter((c) => replies.has(c.key));
  if (kept.length === 0) {
    throw new Error(`${failed} month calls failed`);
  }
  const storyInput = storyInputOf(
    kept,
    kept.map((c) => replies.get(c.key) as Month)
  );
  const { story } = await readReply(
    STORY_PROMPT,
    wording.story,
    storyInput,
    Story
  );
  return [
    "# Relationship history",
    "",
    story,
    ...storyInput.months
      .toReversed()
      .flatMap((m) => ["", `## ${m.month}`, "", m.summary]),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { run: { type: "boolean" } },
  });
  if (positionals.length !== 1) {
    throw new Error("usage: bun scripts/memory-history.ts <person> [--run]");
  }
  const people = await readPeople();
  const { events, failed } = await readWithPeople(new Date(0));
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} sources could not be read; history would be incomplete`
    );
  }
  const [person] = directOf(positionals, events, people);
  if (!person?.known || person.messages.length === 0) {
    throw new Error("no person with one-to-one messages matches");
  }
  const wording = {
    month: await promptText(MONTH_PROMPT),
    story: await promptText(STORY_PROMPT),
  };
  const calls = historyCallsOf(
    person.messages,
    people.nameOf(`person:${person.known}`),
    wording.month
  );
  const dir = join(KEPT, person.known);
  const counts = countsOf(calls, wording, dir);
  console.table([
    {
      ...counts,
      chars: charsOf(person.messages),
      messages: person.messages.length,
    },
  ]);
  if (values.run) {
    const llm = llmFor("main");
    const rec = await metered("memory.history", counts, llm.engine);
    await ended(rec, async () => {
      const markdown = await readHistory(calls, wording, {
        dir,
        llm,
        run: rec.run,
      });
      await Bun.write(join(KEPT, `${person.known}.md`), markdown);
      return counts;
    }).catch(() => {
      // A model or parser error can contain private text; the log keeps it, the terminal gets only counts.
      console.table([{ failed: 1 }]);
      process.exitCode = 1;
    });
  }
}
