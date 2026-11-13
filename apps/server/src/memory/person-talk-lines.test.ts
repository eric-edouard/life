import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import { talkLines } from "./person-talk-lines";

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
  expect(talkLines(list, is)).toEqual([
    "## What their time together was about (titles of Life's last 60 episodes with them, newest first)",
    "- 2026-11: The title of the episode; Another title; Title without start",
    "- 2026-10: Old walk",
    "",
  ]);
});

test("a told episode is not talk; nothing gives nothing", () => {
  const list = [ep(1, "2026-11-10 09:00", "Heard of it", { role: "told" })];
  expect(talkLines(list, is)).toEqual([]);
  expect(talkLines([], is)).toEqual([]);
});
