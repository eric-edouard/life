import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import { episodeTitleLines } from "./person-episode-titles";

const ep = (
  n: number,
  start: string | null,
  title: string,
  o: {
    importance?: number;
    role?: "organizer" | "told" | "with";
    what?: string;
  } = {}
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

test("the titles by month, as pinned", () => {
  const list = [
    ep(1, "2026-10-20 10:00", "Old walk"),
    ep(2, "2026-11-10 09:30", "Another title", { what: "Its what." }),
    ep(3, "2026-11-10 14:05", "The title of the episode", {
      what: "The what in full.",
    }),
    ep(4, null, "Title without start", { what: "Its what." }),
  ];
  expect(episodeTitleLines(list, is)).toEqual([
    "## What their time together was about (titles of Life's last 60 episodes they took part in, newest first)",
    "- 2026-11: The title of the episode; Another title; Title without start",
    "- 2026-10: Old walk",
    "",
  ]);
});

test("a told episode is not talk; nothing gives nothing", () => {
  const list = [ep(1, "2026-11-10 09:00", "Heard of it", { role: "told" })];
  expect(episodeTitleLines(list, is)).toEqual([]);
  expect(episodeTitleLines([], is)).toEqual([]);
});

test("an episode they organized counts; the 61st newest is left out", () => {
  const organized = ep(1, "2026-11-02 10:00", "Their party", {
    role: "organizer",
  });
  expect(episodeTitleLines([organized], is)[1]).toBe("- 2026-11: Their party");
  // 61 episodes a minute apart: T0 is the oldest.
  const many = Array.from({ length: 61 }, (_, i) =>
    ep(i, `2026-10-05 10:${String(i).padStart(2, "0")}`, `T${i}`)
  );
  const titles = episodeTitleLines(many, is).join(" ").match(/T\d+/g) ?? [];
  expect(titles.length).toBe(60);
  expect(titles).not.toContain("T0");
  expect(titles[0]).toBe("T60");
});
