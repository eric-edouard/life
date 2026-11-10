import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXCHANGE_BATCH_CHARS } from "@life/server/src/memory/exchanges";
import { inputsOf } from "@life/server/src/memory/run";
import { type askOnce, CHARS_PER_TOKEN } from "@life/server/src/models/llm";
import type { SourceEvent } from "@life/server/src/records/source";
import { countsOf, historyCallsOf, readHistory } from "./memory-history";

const wording = { month: "month wording", story: "story wording" };
const message = (at: string, fromMe: boolean, text = "hello"): SourceEvent => ({
  at,
  chat: "made-up",
  fromMe,
  id: at,
  sender: fromMe ? "me" : "other",
  source: "whatsapp",
  text,
});

test("months are local and ordered; large months pack whole exchanges using the shared lines", () => {
  const calls = historyCallsOf(
    [
      message("2026-11-02T12:00:00.000Z", true),
      message("2026-10-31T23:30:00.000Z", false),
      message(
        "2026-10-01T12:00:00.000Z",
        false,
        "x".repeat(EXCHANGE_BATCH_CHARS)
      ),
      message("2026-10-02T12:00:00.000Z", true),
    ],
    "A made-up friend",
    wording.month
  );
  expect(calls.map((c) => c.input.month)).toEqual([
    "2026-10",
    "2026-10",
    "2026-11",
  ]);
  expect(calls[0]?.input.lines[0]).toBe("## Exchange 0 · 2026-10-01");
  expect(calls[1]?.input.lines[1]).toBe("[0] 19:00 me: hello");
  expect(calls[2]?.input.lines[0]).toBe("## Exchange 0 · 2026-11-01");
  expect(calls[0]?.key).toBe(inputsOf(wording.month, calls[0]?.input));
  expect(
    historyCallsOf(
      [message("2026-10-01T12:00:00.000Z", false)],
      "Friend",
      "changed"
    )[0]?.key
  ).not.toBe(calls[0]?.key);
});

test("dry run only counts; replies are cached by wording and input, joined in order and written newest month first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-"));
  const calls = historyCallsOf(
    [
      message(
        "2026-10-01T12:00:00.000Z",
        false,
        "x".repeat(EXCHANGE_BATCH_CHARS)
      ),
      message("2026-10-02T12:00:00.000Z", true),
      message("2026-11-02T12:00:00.000Z", false),
    ],
    "A made-up friend",
    wording.month
  );
  const seen: Parameters<typeof askOnce>[0][] = [];
  const ask: typeof askOnce = async (o) => {
    seen.push(o);
    const input = o.input as { month?: string; lines?: string[] };
    await Promise.resolve();
    return input.month
      ? {
          month: input.month,
          summary: `${input.month}: ${input.lines?.[0]} "${input.lines?.[1]?.slice(-5)}"`,
        }
      : { story: "They kept in touch." };
  };
  const options = {
    ask,
    dir,
    llm: { engine: "codex" as const, model: "test" },
    run: "r1",
  };
  try {
    const counts = countsOf(calls, wording, dir);
    expect(counts).toMatchObject({ calls: 4, months: 2 });
    expect(counts.tokensAtMost).toBeGreaterThan(0);
    expect(await readdir(dir)).toEqual([]);
    const markdown = await readHistory(calls, wording, options);
    expect(seen).toHaveLength(4);
    const inputChars = seen.reduce(
      (n, o) =>
        n +
        (o.prompt === "memory-history-month.v0" ? wording.month : wording.story)
          .length +
        JSON.stringify(o.input).length,
      0
    );
    expect(Math.ceil(inputChars / CHARS_PER_TOKEN)).toBeLessThanOrEqual(
      counts.tokensAtMost
    );
    expect(
      seen.every((o) => o.llm === options.llm && o.run === "r1" && !o.tools)
    ).toBe(true);
    expect(seen[3]?.input).toEqual({
      months: [
        {
          month: "2026-10",
          summary:
            '2026-10: ## Exchange 0 · 2026-10-01 "xxxxx"\n\n2026-10: ## Exchange 0 · 2026-10-02 "hello"',
        },
        {
          month: "2026-11",
          summary: '2026-11: ## Exchange 0 · 2026-11-02 "hello"',
        },
      ],
      with: "A made-up friend",
    });
    expect(markdown.indexOf("They kept in touch.")).toBeLessThan(
      markdown.indexOf("## 2026-11")
    );
    expect(markdown.indexOf("## 2026-11")).toBeLessThan(
      markdown.indexOf("## 2026-10")
    );
    expect(await readHistory(calls, wording, options)).toBe(markdown);
    expect(seen).toHaveLength(4);
    expect(countsOf(calls, wording, dir)).toEqual({
      calls: 0,
      months: 2,
      tokensAtMost: 0,
    });
    await readHistory(calls, { ...wording, story: "changed story" }, options);
    expect(seen).toHaveLength(5);
    const changed = { ...wording, month: "changed month" };
    const newCalls = historyCallsOf(
      [message("2026-11-02T12:00:00.000Z", false)],
      "A made-up friend",
      changed.month
    );
    expect(countsOf(newCalls, changed, dir).calls).toBe(2);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("a failed month waits for the other calls and keeps their replies before the run ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-partial-"));
  const calls = historyCallsOf(
    [
      message("2026-10-02T12:00:00.000Z", true),
      message("2026-11-02T12:00:00.000Z", false),
    ],
    "Friend",
    wording.month
  );
  let completed = 0;
  const ask: typeof askOnce = async (o) => {
    const input = o.input as { month: string };
    if (input.month === "2026-10") {
      throw new Error("fake failure");
    }
    await Promise.resolve();
    completed += 1;
    return { month: input.month, summary: 'On 2026-11-02 they said "hello".' };
  };
  try {
    await expect(
      readHistory(calls, wording, {
        ask,
        dir,
        llm: { engine: "codex", model: "test" },
        run: "r1",
      })
    ).rejects.toThrow("1 month calls failed");
    expect(completed).toBe(1);
    expect(countsOf(calls, wording, dir).calls).toBe(2);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("invalid monthly replies are not cached; retry reuses successful months, and wrong months or oversized prose fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-fail-"));
  const calls = historyCallsOf(
    [message("2026-11-02T12:00:00.000Z", false)],
    "Friend",
    wording.month
  );
  let reply: unknown = { month: "2026-10", summary: "Wrong month." };
  const options = {
    ask: () => Promise.resolve(reply),
    dir,
    llm: { engine: "codex" as const, model: "test" },
    run: "r1",
  };
  try {
    await expect(readHistory(calls, wording, options)).rejects.toThrow();
    expect(countsOf(calls, wording, dir).calls).toBe(2);
    reply = { month: "2026-11", summary: "word ".repeat(151) };
    await expect(readHistory(calls, wording, options)).rejects.toThrow();
    reply = { month: "2026-11", summary: 'They said "invented words".' };
    await expect(readHistory(calls, wording, options)).rejects.toThrow();
    reply = { month: "2026-11", summary: 'On 2026-11-02 they said "hello".' };
    // Month succeeds; story fails, so only the story remains to ask.
    await expect(readHistory(calls, wording, options)).rejects.toThrow();
    expect(countsOf(calls, wording, dir).calls).toBe(1);
    reply = { story: "word ".repeat(601) };
    await expect(readHistory(calls, wording, options)).rejects.toThrow();
    expect(countsOf(calls, wording, dir).calls).toBe(1);
    reply = { story: "A short story." };
    expect(await readHistory(calls, wording, options)).toContain(
      "A short story."
    );
    expect(countsOf(calls, wording, dir).calls).toBe(0);
    await expect(readHistory([], wording, options)).rejects.toThrow(
      "no one-to-one messages"
    );
    expect(countsOf([], wording, dir)).toEqual({
      calls: 0,
      months: 0,
      tokensAtMost: 0,
    });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
