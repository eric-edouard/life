import { expect, test } from "bun:test";
import type { InferredRepo } from "../records/observation";
import type { Unit } from "../records/unit";
import { repoMap } from "../sources/git";
import type { Truth } from "./read-truth";
import { ledger, unit, verdict } from "./record-fixtures";
import { codeRows, parseInferredRepos } from "./repos";
import { areaLookup } from "./tags";

const ctx = {
  areas: areaLookup([
    { id: "work", name: "Work" },
    { id: "shop", name: "Shop" },
  ]),
  at: "2026-10-15T10:00:00.000Z",
  madeBy: {
    engine: "claude" as const,
    model: "haiku",
    prompt: "repo-project.v1",
    run: "r1",
  },
  projects: new Map([["bakery", "shop"]]),
};
const entry = (over: object) => ({
  area: null,
  key: "bakery-hq",
  newProject: null,
  project: null,
  why: "Ads and SEO.",
  ...over,
});

test("a repo on one of his projects takes the project's area; a project that is not his becomes none", () => {
  const { invalid, records, unknownProject } = parseInferredRepos(
    {
      repos: [
        entry({ area: "work", project: "bakery" }),
        entry({
          area: "Work",
          key: "cove",
          newProject: "Cove: call recorder",
          project: "cove",
        }),
        entry({ key: "mmdetection", newProject: "Detection: a clone" }),
        entry({ key: "not-asked" }),
        entry({ key: "bakery-hq" }),
        { key: "broken" },
      ],
    },
    new Set(["bakery-hq", "cove", "mmdetection"]),
    ctx
  );
  expect(records.map((r) => [r.repo, r.project, r.area, r.newProject])).toEqual(
    [
      ["bakery-hq", "bakery", "shop", null],
      ["cove", null, "work", "Cove: call recorder"],
      ["mmdetection", null, null, "Detection: a clone"],
    ]
  );
  expect(unknownProject).toBe(1);
  // A repo we did not ask about, a repeat and a malformed entry.
  expect(invalid).toBe(3);
});

test("the repo map: truth wins over what Life inferred, which maps what truth doesn't", () => {
  const inferredRepo = (
    repo: string,
    project: string | null
  ): InferredRepo => ({
    ...ctx,
    area: "work",
    newProject: null,
    project,
    repo,
    schemaVersion: 1,
    why: "x",
  });
  const truth = {
    projects: [{ area: "shop", id: "bakery", repos: ["bakery-hq"] }],
  } as unknown as Truth;
  const map = repoMap(truth, [
    inferredRepo("bakery-hq", "life"),
    inferredRepo("cove", null),
  ]);
  expect(map.get("bakery-hq")).toEqual({ area: "shop", project: "bakery" });
  expect(map.get("cove")?.project).toBeNull();
  expect(map.get("cove")?.inferred?.repo).toBe("cove");
});

const gitDay = (key: string, over: Partial<Unit["stats"]>, id: number) =>
  unit({
    date: "2026-10-14",
    hash: "0000000000000000",
    id: `unit_${String(id).padStart(12, "0")}`,
    key,
    source: "git",
    stats: { added: 10, chars: 0, fromMe: 1, items: 1, removed: 1, ...over },
    title: key,
  });

test("code rows: one per project, repos by commits, lines summed, the three most frequent topics; unmapped repos together", () => {
  const units = [
    gitDay("bakery-site", { added: 100, items: 9, removed: 10 }, 1),
    gitDay("bakery-hq", { added: 4673, items: 33, removed: 199 }, 2),
    gitDay(
      "photo-app",
      { fromMe: 2, items: 14, others: { "Jérôme Petit": 12 } },
      3
    ),
    gitDay("mmdetection", { items: 1 }, 4),
  ];
  const topics = [
    ["seo", "ads"],
    ["seo", "recruitment", "ads"],
    ["vision"],
    [],
  ];
  const verdicts = ledger(
    units.map((u, i) => verdict(u, { topics: topics[i] }))
  );
  const map = new Map([
    ["bakery-hq", { area: "shop", project: "bakery" }],
    ["bakery-site", { area: "shop", project: "bakery" }],
    ["photo-app", { area: "work", project: "photo-app" }],
  ]);
  const rows = codeRows(units, verdicts, map, [
    { id: "bakery", name: "Bakery (Lille)" },
    { id: "photo-app", name: "photo-app" },
  ]);
  expect(rows).toEqual([
    {
      name: "Bakery (Lille)",
      relation:
        "bakery-hq 33, bakery-site 9 · +4,773 −209 · ads, seo, recruitment",
    },
    {
      name: "photo-app",
      relation: "photo-app 14 (Jérôme 12) · +10 −1 · vision",
    },
    { name: "Other repos", relation: "mmdetection 1 · +10 −1" },
  ]);
});
