import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../log";
import { Action } from "../schema";
import { changeFeed, feedPage, matchesFilter } from "./feed";
import { action } from "./fixtures";
import { assembleRuns, lifeStatus, percentOf, runs, useText } from "./history";
import { ACTIONS, appendJsonl } from "./ledger";

/** Pages through the sources with `limit`, appending `between` after each page, until the feed is drained. */
function drain(
  sources: { lines: string[]; name: string }[],
  limit: number,
  between: (page: number) => void = () => undefined,
  keep = (_line: string) => true
) {
  const seen: string[] = [];
  let cursor = {};
  for (let page = 0; page < 50; page += 1) {
    const r = feedPage(sources, cursor, limit, (_s, line) =>
      keep(line) ? line : null
    );
    expect(r.items.length).toBeLessThanOrEqual(limit);
    seen.push(...r.items);
    cursor = JSON.parse(Buffer.from(r.cursor, "base64url").toString());
    between(page);
    if (r.items.length === 0 && r.remaining === 0) {
      return seen;
    }
  }
  throw new Error("never drained");
}

test("the feed returns every line once across pages, with lines appended to any source meanwhile", () => {
  const a = { lines: ["a0", "a1", "a2"], name: "a" };
  const b = { lines: ["b0", "b1"], name: "b" };
  const seen = drain([a, b], 2, (page) => {
    if (page === 0) {
      a.lines.push("a3"); // to a source the cursor already passed
    }
    if (page === 2) {
      b.lines.push("b2");
      a.lines.push("a4");
    }
  });
  expect(seen.sort()).toEqual(
    ["a0", "a1", "a2", "a3", "a4", "b0", "b1", "b2"].sort()
  );
});

test("a filter skips lines without losing any match, and `remaining` counts only matches", () => {
  const s = { lines: ["x0", "y1", "x2", "y3", "x4", "x5"], name: "s" };
  const first = feedPage([s], {}, 2, (_n, l) => (l.startsWith("x") ? l : null));
  expect(first.items).toEqual(["x0", "x2"]);
  expect(first.remaining).toBe(2);
  expect(drain([s], 1, undefined, (l) => l.startsWith("x"))).toEqual([
    "x0",
    "x2",
    "x4",
    "x5",
  ]);
});

test("a cursor past the end of a ledger (it shrank) is an error, not a silent restart", () => {
  const s = { lines: ["a"], name: "s" };
  expect(() => feedPage([s], { s: 2 }, 5, (_n, l) => l)).toThrow(
    "cursor is past the end of s"
  );
});

const ev = (
  kind: string,
  step: string,
  at: string,
  extra: Record<string, unknown> = {}
) => ({ at, kind, step, ...extra });
const id = (at: string) => at.replaceAll(":", "-");

test("runs: sweeps hold their steps; failed, unfinished, running and old run-less errors stay visible", () => {
  const night = "2026-10-15T00:31:00.000Z";
  const triage = "2026-10-15T00:31:05.000Z";
  const extract = "2026-10-14T11:00:00.000Z";
  const midday = "2026-10-14T17:00:00.000Z";
  const now = "2026-10-15T12:00:00.000Z";
  const events = [
    ev("run.start", "memory.nightly", night, { days: 7, run: id(night) }),
    ev("run.start", "memory.moments", triage, { days: 7, run: id(triage) }),
    ev("run.end", "memory.moments", "2026-10-15T00:32:00.000Z", {
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
    ev("run.start", "memory.midday", midday, { run: id(midday) }),
    ev("run.error", "memory.nightly", "2026-10-13T01:00:00.000Z", {
      error: "triage: 1 failed",
    }),
    ev("run.start", "memory.pages", now, { run: id(now) }),
    ev("run.start", "memory.intent", now, { run: id(now) }),
  ];
  const steps = new Set([
    "memory.nightly",
    "memory.midday",
    "memory.moments",
    "memory.extract",
    "memory.pages",
  ]);
  const list = assembleRuns(events, steps, new Date(now));
  const by = (step: string) => list.find((r) => r.step === step);
  expect(by("memory.nightly")).toMatchObject({
    children: [`memory.moments/${id(triage)}`],
    errors: [{ error: "offline", step: "memory.nightly.actions" }],
    outcome: "ok",
    // What the night's report listed, for an audit (docs/audits.md).
    result: { listed: ["obs_000000000001"] },
  });
  expect(by("memory.moments")).toMatchObject({
    outcome: "ok",
    result: { units: 9 },
    sweep: `memory.nightly/${id(night)}`,
    window: { from: "2026-10-09" },
  });
  expect(by("memory.extract")?.outcome).toBe("failed");
  expect(by("memory.midday")?.outcome).toBe("unfinished");
  expect(by("memory.pages")?.outcome).toBe("running");
  expect(list.find((r) => r.startedAt === null)).toMatchObject({
    endedAt: "2026-10-13T01:00:00.000Z",
    outcome: "failed",
    step: "memory.nightly",
  });
  expect(list.some((r) => r.step === "memory.intent")).toBe(false);
});

test("an interrupted sweep ends where the next one starts: it never claims later steps", () => {
  const first = "2026-10-15T00:31:00.000Z";
  const second = "2026-10-16T00:31:00.000Z";
  const later = "2026-10-16T00:32:00.000Z";
  const list = assembleRuns(
    [
      ev("run.start", "memory.nightly", first, { run: id(first) }),
      ev("run.start", "memory.nightly", second, { run: id(second) }),
      ev("run.start", "memory.moments", later, { run: id(later) }),
      ev("run.error", "memory.nightly.actions", later, { error: "offline" }),
    ],
    new Set(["memory.nightly", "memory.moments"]),
    null
  );
  const sweep = (at: string) =>
    list.find((r) => r.id === `memory.nightly/${id(at)}`);
  expect(sweep(first)).toMatchObject({
    children: [],
    errors: [],
    outcome: "unfinished",
  });
  expect(sweep(second)?.children).toEqual([`memory.moments/${id(later)}`]);
  expect(sweep(second)?.errors).toHaveLength(1);
});

test("runs page back through the log days, newest first, none lost or repeated, and new runs never shift a cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-runs-"));
  const line = (step: string, at: string, kind = "run.start") =>
    `${JSON.stringify(ev(kind, step, at, { failed: 0, run: id(at) }))}\n`;
  const starts: string[] = [];
  for (const day of ["2026-10-12", "2026-10-13", "2026-10-14"]) {
    let text = "";
    for (const h of ["01", "09", "17"]) {
      const at = `${day}T${h}:00:00.000Z`;
      starts.push(at);
      text +=
        line("memory.moments", at) + line("memory.moments", at, "run.end");
    }
    writeFileSync(join(dir, `${day}.jsonl`), text);
  }
  // A run that started late on the 14th and ended after midnight UTC.
  const late = "2026-10-14T23:59:00.000Z";
  starts.push(late);
  appendFileSync(join(dir, "2026-10-14.jsonl"), line("memory.moments", late));
  writeFileSync(
    join(dir, "2026-10-15.jsonl"),
    line("memory.moments", late, "run.end")
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
        line("memory.moments", "2026-10-15T08:00:00.000Z")
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
});

test("the dashboard only reads: no write, log, model call, action or send", async () => {
  const source = (
    await Promise.all(
      ["feed.ts", "history.ts"].map((f) =>
        Bun.file(join(import.meta.dir, f)).text()
      )
    )
  ).join("\n");
  for (const banned of [
    "Bun.write",
    "appendFile",
    "writeFile",
    "log(",
    "askOnce",
    "actAsked",
    "sendReport",
    "Bun.spawn",
    "locked(",
  ]) {
    expect(source).not.toContain(banned);
  }
  // git only reads: log and show.
  for (const m of source.matchAll(/git\(\w+, \[\s*"([a-z-]+)"/g)) {
    expect(["log", "show"]).toContain(m[1] as string);
  }
});

test("a run filter takes the id as runs gives it, or bare", () => {
  const it = {
    about: [],
    recordedAt: "t",
    run: "2026-10-18T09-56-02.943Z",
    type: "observation.extracted",
  };
  expect(
    matchesFilter(it, { run: "memory.extract/2026-10-18T09-56-02.943Z" })
  ).toBe(true);
  expect(matchesFilter(it, { run: "2026-10-18T09-56-02.943Z" })).toBe(true);
  expect(
    matchesFilter(it, { run: "memory.extract/2026-10-17T00-00-00.000Z" })
  ).toBe(false);
});

test("the status holds the midday while the last quota reading is over the reserve; an unread one holds nothing", async () => {
  const now = new Date();
  const resetsAt = new Date(now.getTime() + 86_400_000).toISOString();
  log("quota.read", { resetsAt, used: 80 });
  expect((await lifeStatus(now)).midday.next.why).toStartWith("held");
  log("quota.read");
  expect((await lifeStatus(now)).midday.next.why).not.toStartWith("held");
});

test("changes about task:<id> is one task's history: its ask, updates and replies, no other action", async () => {
  const ask = "act_00000000000a";
  const own = (kind: Action["kind"], target: string, n: number) =>
    action({
      id: `act_${String(n).padStart(12, "0")}`,
      instruction: undefined,
      kind,
      target,
    });
  try {
    appendJsonl(ACTIONS, Action, [
      action({ id: ask, kind: "ask", target: "atlas" }),
      own("update", ask, 1),
      own("reply", ask, 2),
      own("reply", "chat", 3),
      own("update", "act_00000000000b", 4),
      own("add", "reminder:12", 5),
    ]);
    const { items } = await changeFeed({ about: `task:${ask}` });
    expect(items.map((i) => i.type)).toEqual([
      "action.ask",
      "action.update",
      "action.reply",
    ]);
  } finally {
    rmSync(ACTIONS, { force: true });
  }
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
    ev("run.start", "memory.moments", step, { run: id(step) }),
    call(id(step), 1000),
    call(id(step), 3000),
    call("other", 5),
    ev("run.end", "memory.moments", "2026-10-15T00:40:00.000Z", {
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
    new Set(["memory.nightly", "memory.moments"]),
    null
  );
  const by = (s: string) => list.find((r) => r.step === s);
  const spent = { cached: 2000, input: 4000, output: 20 };
  expect(by("memory.moments")?.use).toEqual({ quota: null, tokens: spent });
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
});

test("a sweep's run holds its phases in the order it entered them", () => {
  const at = "2026-10-15T00:31:00.000Z";
  const phase = (p: string, s: number) =>
    ev("run.phase", "memory.nightly", `2026-10-15T00:3${s}:00.000Z`, {
      phase: p,
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
  expect(list[0]?.phases).toEqual(["repos", "gather", "index"]);
});
