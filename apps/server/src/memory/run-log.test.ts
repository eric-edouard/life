import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleRuns,
  percentOf,
  type Run,
  runs,
  spendLines,
  useText,
} from "./run-log";

const ev = (
  kind: string,
  step: string,
  at: string,
  extra: Record<string, unknown> = {}
) => ({ at, kind, step, ...extra });
const id = (at: string) => at.replaceAll(":", "-");

test("runs: processing runs hold their steps; failed, unfinished, running and old run-less errors stay visible", () => {
  const night = "2026-10-15T00:31:00.000Z";
  const triage = "2026-10-15T00:31:05.000Z";
  const extract = "2026-10-14T11:00:00.000Z";
  const backfill = "2026-10-14T17:00:00.000Z";
  const now = "2026-10-15T12:00:00.000Z";
  const events = [
    ev("run.start", "memory.nightly", night, { days: 7, run: id(night) }),
    ev("run.start", "memory.episodes", triage, { days: 7, run: id(triage) }),
    ev("run.end", "memory.episodes", "2026-10-15T00:32:00.000Z", {
      failed: 0,
      run: id(triage),
      units: 9,
    }),
    ev("run.error", "memory.nightly.actions", "2026-10-15T00:33:00.000Z", {
      error: "offline",
    }),
    ev("run.end", "memory.nightly", "2026-10-15T00:34:00.000Z", {
      listed: ["obs_000000000001"],
      outcome: "ok",
      run: id(night),
    }),
    ev("run.start", "memory.extract", extract, { run: id(extract) }),
    ev("run.end", "memory.extract", "2026-10-14T11:01:00.000Z", {
      failed: 2,
      run: id(extract),
    }),
    ev("run.start", "memory.backfill", backfill, { run: id(backfill) }),
    ev("run.error", "memory.nightly", "2026-10-13T01:00:00.000Z", {
      error: "triage: 1 failed",
    }),
    ev("run.start", "memory.pages", now, { run: id(now) }),
    ev("run.start", "memory.intent", now, { run: id(now) }),
  ];
  const steps = new Set([
    "memory.nightly",
    "memory.backfill",
    "memory.episodes",
    "memory.extract",
    "memory.pages",
  ]);
  const list = assembleRuns(events, steps, new Date(now));
  const by = (step: string) => list.find((r) => r.step === step);
  expect(by("memory.nightly")).toMatchObject({
    children: [`memory.episodes/${id(triage)}`],
    errors: [{ error: "offline", step: "memory.nightly.actions" }],
    outcome: "ok",
    // What the night's report listed, for an audit (docs/operations.md, "Regression cases").
    result: { listed: ["obs_000000000001"] },
  });
  expect(by("memory.episodes")).toMatchObject({
    outcome: "ok",
    processingRun: `memory.nightly/${id(night)}`,
    result: { units: 9 },
    window: { from: "2026-10-09" },
  });
  expect(by("memory.extract")?.outcome).toBe("failed");
  expect(by("memory.backfill")?.outcome).toBe("unfinished");
  expect(by("memory.pages")?.outcome).toBe("running");
  expect(list.find((r) => r.startedAt === null)).toMatchObject({
    endedAt: "2026-10-13T01:00:00.000Z",
    outcome: "failed",
    step: "memory.nightly",
  });
  expect(list.some((r) => r.step === "memory.intent")).toBe(false);
});

test("an interrupted processing run ends where the next one starts: it never claims later steps", () => {
  const first = "2026-10-15T00:31:00.000Z";
  const second = "2026-10-16T00:31:00.000Z";
  const later = "2026-10-16T00:32:00.000Z";
  const list = assembleRuns(
    [
      ev("run.start", "memory.nightly", first, { run: id(first) }),
      ev("run.start", "memory.nightly", second, { run: id(second) }),
      ev("run.start", "memory.episodes", later, { run: id(later) }),
      ev("run.error", "memory.nightly.actions", later, { error: "offline" }),
    ],
    new Set(["memory.nightly", "memory.episodes"]),
    null
  );
  const processingRun = (at: string) =>
    list.find((r) => r.id === `memory.nightly/${id(at)}`);
  expect(processingRun(first)).toMatchObject({
    children: [],
    errors: [],
    outcome: "unfinished",
  });
  expect(processingRun(second)?.children).toEqual([
    `memory.episodes/${id(later)}`,
  ]);
  expect(processingRun(second)?.errors).toHaveLength(1);
});

test("runs page back through the log days, newest first, none lost or repeated, and new runs never shift a cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-runs-"));
  const line = (step: string, at: string, kind = "run.start") =>
    `${JSON.stringify(ev(kind, step, at, { failed: 0, run: id(at) }))}\n`;
  const starts: string[] = [];
  for (const day of [
    "2026-10-09",
    "2026-10-10",
    "2026-10-11",
    "2026-10-12",
    "2026-10-13",
    "2026-10-14",
  ]) {
    let text = "";
    for (const h of ["01", "09", "17"]) {
      const at = `${day}T${h}:00:00.000Z`;
      starts.push(at);
      text +=
        line("memory.episodes", at) + line("memory.episodes", at, "run.end");
    }
    writeFileSync(join(dir, `${day}.jsonl`), text);
  }
  // A run that started late on the 14th and ended after midnight UTC.
  const late = "2026-10-14T23:59:00.000Z";
  starts.push(late);
  appendFileSync(join(dir, "2026-10-14.jsonl"), line("memory.episodes", late));
  writeFileSync(
    join(dir, "2026-10-15.jsonl"),
    line("memory.episodes", late, "run.end")
  );
  const seen: string[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < 20; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: pages follow each other
    const r = await runs({ cursor: cursor ?? undefined, limit: 2 }, dir);
    seen.push(...r.items.map((i) => i.startedAt as string));
    if (page === 1) {
      appendFileSync(
        join(dir, "2026-10-15.jsonl"),
        line("memory.episodes", "2026-10-15T08:00:00.000Z")
      );
    }
    ({ cursor } = r);
    if (!cursor) {
      break;
    }
  }
  expect(seen).toEqual([...starts].sort().reverse());
  const first = await runs({ limit: 1 }, dir);
  expect(first.items[0]?.startedAt).toBe("2026-10-15T08:00:00.000Z");
  expect(first.items[0]?.outcome).toBe("unfinished");
  // A rare step on the first and last days: each page reads back as far as it needs (assembled at 1, 2, 4… days).
  for (const [day, at] of [
    ["2026-10-09", "2026-10-09T05:00:00.000Z"],
    ["2026-10-15", "2026-10-15T09:00:00.000Z"],
  ] as const) {
    appendFileSync(
      join(dir, `${day}.jsonl`),
      line("memory.rare", at) + line("memory.rare", at, "run.end")
    );
  }
  const rare = await runs({ limit: 1, steps: ["memory.rare"] }, dir);
  expect(rare.items.map((r) => r.startedAt)).toEqual([
    "2026-10-15T09:00:00.000Z",
  ]);
  const older = await runs(
    { cursor: rare.cursor ?? undefined, limit: 1, steps: ["memory.rare"] },
    dir
  );
  expect(older.items.map((r) => r.startedAt)).toEqual([
    "2026-10-09T05:00:00.000Z",
  ]);
  expect(older.cursor).toBeNull();
});

test("a run's use: its calls' tokens and its steps', and for a metered run the quota it logged at its start and end", () => {
  const night = "2026-10-15T00:31:00.000Z";
  const step = "2026-10-15T00:31:05.000Z";
  const tokens = (input: number) => ({ cached: input / 2, input, output: 10 });
  const q = (used: number) => ({ resetsAt: "2026-10-20T00:00:00.000Z", used });
  const call = (run: string, input: number) => ({
    at: step,
    kind: "model.run",
    run,
    tokens: tokens(input),
  });
  const events = [
    ev("run.start", "memory.nightly", night, { quota: q(40), run: id(night) }),
    ev("run.start", "memory.episodes", step, { run: id(step) }),
    call(id(step), 1000),
    call(id(step), 3000),
    call("other", 5),
    ev("run.end", "memory.episodes", "2026-10-15T00:40:00.000Z", {
      failed: 0,
      run: id(step),
    }),
    ev("run.end", "memory.nightly", "2026-10-15T00:41:01.000Z", {
      outcome: "ok",
      quota: q(43),
      run: id(night),
    }),
  ];
  const list = assembleRuns(
    // model.run lines name no step.
    events as Parameters<typeof assembleRuns>[0],
    new Set(["memory.nightly", "memory.episodes"]),
    null
  );
  const by = (s: string) => list.find((r) => r.step === s);
  const spent = { cached: 2000, input: 4000, output: 20 };
  expect(by("memory.episodes")?.use).toEqual({ quota: null, tokens: spent });
  const use = by("memory.nightly")?.use;
  expect(use).toEqual({
    quota: { after: q(43), before: q(40) },
    tokens: spent,
  });
  expect(use && percentOf(use)).toBe(3);
  expect(useText(use ?? null)).toBe("+3% of the quota, 4k tokens (2k cached)");
  expect(
    useText({
      quota: { after: q(40), before: q(40) },
      tokens: tokens(2_000_000),
    })
  ).toBe("under 1% of the quota, 2.0M tokens (1.0M cached)");
  const reset = { resetsAt: "2026-10-27T00:00:00.000Z", used: 1 };
  expect(
    useText({ quota: { after: reset, before: q(90) }, tokens: tokens(0) })
  ).toBe("the quota reset during it, 0k tokens (0k cached)");
  // A step, or a run on an engine with no quota (allmodels): its tokens alone, no "quota not read".
  expect(useText(by("memory.episodes")?.use ?? null)).toBe(
    "4k tokens (2k cached)"
  );
});

test("a processing run holds its steps in the order it entered them", () => {
  const at = "2026-10-15T00:31:00.000Z";
  const phase = (p: string, s: number) =>
    ev("run.entered", "memory.nightly", `2026-10-15T00:3${s}:00.000Z`, {
      entered: p,
      run: id(at),
    });
  const list = assembleRuns(
    [
      ev("run.start", "memory.nightly", at, { run: id(at) }),
      phase("repos", 2),
      phase("gather", 3),
      phase("index", 4),
    ],
    new Set(["memory.nightly"]),
    null
  );
  expect(list[0]?.processingSteps).toEqual(["repos", "gather", "index"]);
});

const IMPORT_LINE = /^Model use, import of .*: 3k tokens \(0k cached\)$/;

test("spend lines: every run of the window that called a model, oldest first, a processing run's steps under it", () => {
  const t = (input: number) => ({
    quota: null,
    tokens: { cached: 0, input, output: 0 },
  });
  const runOf = (
    ref: string,
    startedAt: string,
    more: Partial<Run> = {}
  ): Run => ({
    endedAt: null,
    errors: [],
    id: ref,
    input: null,
    outcome: "ok",
    result: null,
    startedAt,
    step: ref.split("/")[0] ?? "",
    use: t(1000),
    ...more,
  });
  const lines = spendLines(
    [
      runOf("memory.import/c", "2026-10-28T09:00:00.000Z", { use: t(3000) }),
      runOf("memory.pages/s2", "2026-10-28T01:20:00.000Z", {
        processingRun: "memory.nightly/n",
        use: t(2000),
      }),
      runOf("memory.episodes/s1", "2026-10-28T01:10:00.000Z", {
        processingRun: "memory.nightly/n",
      }),
      runOf("memory.nightly/n", "2026-10-28T01:00:00.000Z", { use: t(3000) }),
      runOf("memory.files/q", "2026-10-28T02:00:00.000Z", { use: null }),
      runOf("memory.backfill/old", "2026-10-26T13:00:00.000Z"),
    ],
    "2026-10-27T09:30:00.000Z",
    { id: "memory.nightly/n", quota: undefined }
  );
  expect(lines).toEqual([
    "Model use, this night: 3k tokens (0k cached)",
    "  episodes: 1k tokens (0k cached)",
    "  pages: 2k tokens (0k cached)",
    expect.stringMatching(IMPORT_LINE),
  ]);
});
