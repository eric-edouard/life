import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import { latelyLines, talkLines } from "./person-episode-lines";

const ep = (
  n: number,
  start: string | null,
  title: string,
  o: { importance?: number; role?: "told" | "with"; what?: string } = {}
) =>
  ({
    day: (start ?? "").slice(0, 10) || "2026-11-08",
    id: `ep_${n}`,
    importance: o.importance ?? 2,
    people: [{ ref: "person:ann", role: o.role ?? "with" }],
    start,
    title,
    what: o.what ?? "It went well.",
  }) as unknown as Episode;

const is = (ref: string) => ref === "person:ann";

test("the two blocks, as pinned", () => {
  const list = [
    ep(1, "2026-10-20 10:00", "Old walk"),
    ep(2, "2026-11-10 09:30", "Another title", { what: "Its what." }),
    ep(3, "2026-11-10 14:05", "The title of the episode", {
      what: "The what in full.",
    }),
    ep(4, null, "Title without start", { what: "Its what." }),
  ];
  expect(latelyLines(list, "2026-11-12")).toEqual([
    "## Lately with them, day by day (Life's episodes of the last 14 days, from every source; newest first)",
    "- 2026-11-10 14:05 The title of the episode. The what in full.",
    "- 2026-11-10 09:30 Another title. Its what.",
    "- 2026-11-08 Title without start. Its what.",
    "",
  ]);
  expect(talkLines(list, is)).toEqual([
    "## What their time together was about (titles of Life's last 60 episodes with them, newest first)",
    "- 2026-11: The title of the episode; Another title; Title without start",
    "- 2026-10: Old walk",
    "",
  ]);
});

test("the window is 14 days", () => {
  const list = [
    ep(1, "2026-10-28 10:00", "Too old"),
    ep(2, "2026-10-30 10:00", "In"),
  ];
  expect(latelyLines(list, "2026-11-12").join("\n")).toContain("In.");
  expect(latelyLines(list, "2026-11-12").join("\n")).not.toContain("Too old");
});

test("12 at most, importance 3 before 1", () => {
  const list = [
    ep(0, "2026-11-01 08:00", "Big", { importance: 3 }),
    ...Array.from({ length: 12 }, (_, i) =>
      ep(i + 1, `2026-11-02 ${String(i + 10)}:00`, `Small ${i}`, {
        importance: 1,
      })
    ),
  ];
  const out = latelyLines(list, "2026-11-12");
  expect(out.filter((l) => l.startsWith("- "))).toHaveLength(12);
  expect(out.join("\n")).toContain("Big.");
  expect(out.join("\n")).not.toContain("Small 0.");
});

test("told is lately but not talk; nothing gives nothing", () => {
  const list = [ep(1, "2026-11-10 09:00", "Heard of it", { role: "told" })];
  expect(latelyLines(list, "2026-11-12")).toHaveLength(3);
  expect(talkLines(list, is)).toEqual([]);
  expect(latelyLines([], "2026-11-12")).toEqual([]);
  expect(talkLines([], is)).toEqual([]);
});
