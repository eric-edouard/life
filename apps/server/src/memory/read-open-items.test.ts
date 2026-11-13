import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Observation } from "../records/observation";
import { buildIndex } from "./index-writer";
import type { Candidate } from "./open-items";
import { openWithOf } from "./read-open-items";
import { OWNER } from "./read-truth";

test("a person's page lists everything open with them, what he owes first, then what he waits on", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "life-open-")), "i.sqlite");
  const obs = (id: string, over: Partial<Observation>) =>
    ({
      about: OWNER,
      at: "2026-09-01T10:00:00.000Z",
      confidence: 0.9,
      date: "2026-09-01",
      id,
      importance: 3,
      quote: "I'll send Ana the plans",
      source: { channel: "lifelog", ref: "j:1@x" },
      speaker: OWNER,
      subjects: [OWNER, "person:ana"],
      text: "Send Ana the plans.",
      type: "to_do",
      unit: "unit_000000000001",
      when: "2026-09-02",
      ...over,
    }) as unknown as Observation;
  buildIndex(
    [
      // Two months old: past read_day's week, still open with her.
      obs("obs_000000000001", {}),
      obs("obs_000000000002", { type: "waiting_on_someone", when: undefined }),
      obs("obs_000000000003", { subjects: [OWNER, "person:bob"] }),
      obs("obs_000000000004", {}),
      obs("obs_000000000005", { importance: 2 }),
    ],
    path,
    {
      corrections: [],
      latest: new Map(),
      live: new Set(["unit_000000000001"]),
      retired: new Map([
        [
          "obs_000000000004",
          { by: "obs_000000000001", observation: "obs_000000000004" },
        ],
      ]),
    } as never
  );
  const thing = (id: string, over: Partial<Candidate>): Candidate => ({
    at: "2026-11-01T10:00:00.000Z",
    id,
    kind: "reply",
    line: `- ${id}`,
    ...over,
  });
  const lines = openWithOf(
    new Database(path, { readonly: true }),
    "person:ana",
    {
      goals: [],
      more: [
        thing("m_ana", { person: "person:ana" }),
        thing("m_bob", { person: "person:bob" }),
        thing("entry_1", { kind: "todo_item", obs: "obs_000000000001" }),
        thing("entry_3", { kind: "todo_item", obs: "obs_000000000003" }),
        thing("entry_x", { kind: "todo_item" }),
      ],
      today: "2026-11-08",
    }
  );
  expect(
    lines.map((l) => l.split(" (")[0]?.split(" ").slice(0, 2).join(" "))
  ).toEqual([
    "",
    "Open with",
    "",
    "He owes",
    "- m_ana",
    "- obs_000000000001",
    "",
    "He waits",
    "- obs_000000000002",
  ]);
  expect(lines[5]).toEndWith("(overdue) (also entry_1)");
  expect(
    openWithOf(new Database(path, { readonly: true }), "person:cy", {
      goals: [],
      more: [],
      today: "2026-11-08",
    })
  ).toEqual([]);
});
