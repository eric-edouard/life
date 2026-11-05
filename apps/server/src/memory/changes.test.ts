import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { appendJsonl } from "../core/files";
import { AGENT_WORD } from "../core/names";
import { LedgerEntry } from "../records/ledger-entry";
import { changeFeed, feedPage, matchesFilter } from "./changes";
import { LEDGER } from "./ledger";
import { action } from "./record-fixtures";

/** A feed source of `lines` as they are now. */
const asSource = (s: { lines: string[]; name: string }) => ({
  count: s.lines.length,
  lines: () => s.lines,
  name: s.name,
});

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
    const r = feedPage(sources.map(asSource), cursor, limit, (_s, line) =>
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
  const first = feedPage([asSource(s)], {}, 2, (_n, l) =>
    l.startsWith("x") ? l : null
  );
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
  expect(() => feedPage([asSource(s)], { s: 2 }, 5, (_n, l) => l)).toThrow(
    "cursor is past the end of s"
  );
});

test("changes about task:<id> is one task's history: its ask, updates and replies, no other action", async () => {
  const ask = "entry_00000000000a";
  const own = (kind: LedgerEntry["kind"], target: string, n: number) =>
    action({
      id: `entry_${String(n).padStart(12, "0")}`,
      instruction: undefined,
      kind,
      target,
    });
  try {
    appendJsonl(LEDGER, LedgerEntry, [
      action({ id: ask, kind: "ask", target: AGENT_WORD }),
      own("update", ask, 1),
      own("reply", ask, 2),
      own("reply", "chat", 3),
      own("update", "entry_00000000000b", 4),
      own("add", "reminder:12", 5),
    ]);
    const { items } = await changeFeed({ about: `task:${ask}` });
    expect(items.map((i) => i.type)).toEqual([
      "ledger.ask",
      "ledger.update",
      "ledger.reply",
    ]);
  } finally {
    rmSync(LEDGER, { force: true });
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

test("a source the cursor has reached is not read", () => {
  const unread = {
    count: 1,
    lines: () => {
      throw new Error("read");
    },
    name: "b",
  };
  const page = feedPage(
    [asSource({ lines: ["a0"], name: "a" }), unread],
    { b: 1 },
    5,
    (_s, l) => l
  );
  expect(page.items).toEqual(["a0"]);
});
