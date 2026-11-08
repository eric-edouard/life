import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendJsonl } from "../core/files";
import type {
  Correction,
  Extracted,
  Observation,
  Supersession,
} from "../records/observation";
import { type Rating, Statement } from "../records/statement";
import { buildIndex } from "./index-writer";
import {
  hiding,
  INDEX,
  isCurrent,
  latestExtractions,
  latestRatings,
  newSince,
  OBSERVATIONS,
  outdatedBy,
  ratedCorrections,
  ratedFacts,
  readOrigins,
  readRatings,
  readStanding,
  readUnit,
  recordRating,
  retiredBy,
  STATEMENTS,
  type Standing,
  shownOf,
  stateOf,
  UNITS,
} from "./ledger";
import { knownOn } from "./page-format";
import { madeBy, unit as unitFixture } from "./record-fixtures";

const obs = (id: string, unit: string, unitHash: string, run = "r1") =>
  ({ id, madeBy: { run, unitHash }, unit }) as Observation;
const read = (unit: string, unitHash: string, run = "r1") =>
  ({ run, unit, unitHash }) as Extracted;

test("a unit re-extracted under another hash or prompt keeps only its latest facts; a unit never extracted keeps all; a gone or dropped unit none", () => {
  const all = [
    obs("old", "unit_1", "h1"),
    obs("new", "unit_1", "h2"),
    obs("other", "unit_2", "h1"),
    obs("loose", "unit_3", "h1"),
    obs("v1", "unit_4", "h1"),
    obs("v2", "unit_4", "h1", "r2"),
    obs("cut", "unit_5", "h1"),
  ];
  const ledger = [
    read("unit_1", "h1"),
    read("unit_2", "h1"),
    read("unit_1", "h2"),
    read("unit_4", "h1"),
    read("unit_4", "h1", "r2"),
  ];
  const c = {
    latest: latestExtractions(ledger),
    live: new Set(["unit_1", "unit_2", "unit_3", "unit_4"]),
  };
  expect(all.filter((x) => isCurrent(c, x)).map((x) => x.id)).toEqual([
    "new",
    "other",
    "loose",
    "v2",
  ]);
});

test("new since the last good night means a line first cited since: a re-read is not new, a grown chat-day's new message is", () => {
  const cites = (id: string, ref: string, run: string) =>
    ({ ...obs(id, "unit_chat", "h", run), source: { ref } }) as Observation;
  const LAST = "2026-10-17T02-00-10.000Z";
  const NOON = "2026-10-17T13-00-10.000Z";
  const TONIGHT = "2026-10-18T02-00-10.000Z";
  const all = [
    cites("ask", "msg_ask", LAST),
    // Tonight's re-read of the same chat-day: the same fact re-made, and one re-worded, from the line already cited.
    cites("ask", "msg_ask", TONIGHT),
    cites("ask-reworded", "msg_ask", TONIGHT),
    // A hand run's line counts in tonight's report; so does the message the chat-day grew by.
    cites("noon", "msg_noon", NOON),
    cites("reply", "msg_reply", TONIGHT),
  ];
  expect(
    all.filter(newSince(all, "2026-10-17T02:04:00.000Z")).map((o) => o.id)
  ).toEqual(["noon", "reply"]);
  expect(all.filter(newSince(all))).toHaveLength(5);
});

// Where each observation stands, as the index, a page and the status reads see it. The fixture covers every rule: hidden
// everywhere, hidden on one page, an id written again by a re-extraction, retired (the first supersession wins),
// retired and hidden on a page, a unit never extracted, a unit gone, a claim he rated outdated (retired by itself).
const JEROME = "person:jerome";
const line = (id: string, unit: string, unitHash = "h1", run = "r1") =>
  ({
    ...obs(id, unit, unitHash, run),
    entities: [],
    source: { channel: "lifelog", ref: "x" },
    validTo: null,
  }) as unknown as Observation;
const fixture = {
  corrections: [
    { at: "t", kind: "wrong", observations: ["B"] },
    { at: "t", kind: "not-important", observations: ["C", "R"], page: JEROME },
  ] as Correction[],
  extracted: [
    read("unit_1", "h1"),
    read("unit_2", "h1"),
    read("unit_2", "h2", "r2"),
  ],
  list: [
    line("A", "unit_1"),
    line("B", "unit_1"),
    line("C", "unit_1"),
    line("D", "unit_2"),
    line("D", "unit_2", "h2", "r2"),
    line("E", "unit_2", "h2", "r2"),
    line("R", "unit_2", "h2", "r2"),
    line("L", "unit_9"),
    line("G", "unit_8"),
    line("O", "unit_1"),
  ],
  live: new Set(["unit_1", "unit_2", "unit_9"]),
  retired: new Map<string, Supersession>(
    (
      [
        ["E", "F"],
        ["R", "F"],
      ] as const
    ).map(([id, by]) => [
      id,
      {
        at: "t",
        by,
        page: JEROME,
        validTo: "2026-10-01",
        why: "w",
      } as Supersession,
    ])
  ).set(
    "O",
    outdatedBy(
      ratedCorrections(
        latestRatings([
          { answer: "outdated", at: "2026-10-19T08:00:00Z", ref: "O" },
        ] as Rating[])
      )
    )[0] as Supersession
  ),
};

test("the index, the pages and the status reads agree on where each observation stands", async () => {
  const { index, onPage, statusReads } = await view(fixture);
  expect(index).toEqual([
    { id: "A", superseded_by: null, valid_to: null },
    { id: "C", superseded_by: null, valid_to: null },
    { id: "D", superseded_by: null, valid_to: null },
    { id: "E", superseded_by: "F", valid_to: "2026-10-01" },
    { id: "L", superseded_by: null, valid_to: null },
    { id: "O", superseded_by: "O", valid_to: "2026-10-19" },
    { id: "R", superseded_by: "F", valid_to: "2026-10-01" },
  ]);
  // On Jérôme's page: what it may cite, and whether it can be new there (a retired one only stays cited).
  expect(onPage(JEROME)).toEqual([
    ["A", "new"],
    ["D", "new"],
    ["E", "cited"],
    ["L", "new"],
    ["O", "cited"],
  ]);
  // A line he deleted from the page this run hides its observation there before the ledger has it.
  const deleted = {
    at: "t",
    kind: "not-important",
    observations: ["A"],
    page: JEROME,
  } as Correction;
  expect(onPage(JEROME, [deleted]).map(([id]) => id)).toEqual([
    "D",
    "E",
    "L",
    "O",
  ]);
  expect(onPage("area:home")).toEqual([
    ["A", "new"],
    ["C", "new"],
    ["D", "new"],
    ["E", "cited"],
    ["R", "cited"],
    ["L", "new"],
    ["O", "cited"],
  ]);
  expect(statusReads).toEqual([
    "A active",
    "B hidden wrong",
    `C active hiddenOn ${JEROME}`,
    "D replaced r2",
    "D active",
    "E retired F",
    `R retired F hiddenOn ${JEROME}`,
    "L active",
    "G gone",
    "O retired O",
  ]);
});

/** The fixture as each reader takes it: `observationsNow` and `buildIndex`, a page (`knownOn`), the status reads. */
async function view(f: typeof fixture) {
  const standing = {
    corrections: f.corrections,
    latest: latestExtractions(f.extracted),
    live: f.live,
    retired: f.retired,
  };
  const shown = shownOf(f.list, standing);
  const path = join(await mkdtemp(join(tmpdir(), "life-state-")), "i.sqlite");
  buildIndex(shown, path, standing);
  const db = new Database(path, { readonly: true });
  const index = db
    .query("select id, superseded_by, valid_to from observations order by id")
    .all();
  db.close();
  const onPage = (page: string, found: Correction[] = []) => {
    const known = knownOn(
      shown,
      { ...standing, corrections: [...f.corrections, ...found] },
      page
    );
    return shown
      .filter((x) => known.byId.has(x.id))
      .map((x) => [x.id, known.retired.has(x.id) ? "cited" : "new"]);
  };
  const statusReads = f.list.map((x) => {
    const s = stateOf(x, standing);
    const on = s.hiddenOn ?? [];
    return [
      x.id,
      s.state,
      s.correction ?? s.by,
      on.length > 0 && `hiddenOn ${on}`,
    ]
      .filter(Boolean)
      .join(" ");
  });
  return { index, onPage, statusReads };
}

test("hidden beats gone beats replaced beats retired beats active", () => {
  const x = obs("obs_000000000001", "unit_1", "h1");
  const at = (over: Partial<Standing>): Standing => ({
    corrections: [],
    latest: new Map(),
    live: new Set(["unit_1"]),
    retired: new Map(),
    ...over,
  });
  const wrong = (page?: string) =>
    ({ at: "t", kind: "wrong", observations: [x.id], page }) as Correction;
  const retired = new Map([
    [x.id, { at: "t", by: "obs_000000000002" } as Supersession],
  ]);
  const latest = new Map([["unit_1", read("unit_1", "other", "r2")]]);
  expect(stateOf(x, at({}))).toEqual({ hiddenOn: [], state: "active" });
  expect(stateOf(x, at({ retired }))).toMatchObject({
    by: "obs_000000000002",
    state: "retired",
  });
  expect(stateOf(x, at({ latest, retired })).state).toBe("replaced");
  expect(stateOf(x, at({ latest, live: new Set(), retired })).state).toBe(
    "gone"
  );
  expect(
    stateOf(x, at({ corrections: [wrong()], latest, retired }))
  ).toMatchObject({ correction: "wrong", state: "hidden" });
});

test("hiding gives each correction hiding an id once, in his order, from one index per list", () => {
  const c = (at: string, observations: string[], kind = "wrong") =>
    ({ at, kind, observations }) as Correction;
  const list = [
    c("t1", ["A", "A", "B"]),
    c("t2", ["A"], "outdated"),
    c("t3", ["A"], "not-important"),
  ];
  expect(hiding(list, "A").map((h) => h.at)).toEqual(["t1", "t3"]);
  expect(hiding(list, "B").map((h) => h.at)).toEqual(["t1"]);
  expect(hiding(list, "C")).toEqual([]);
});

test("a retirement stands only while its replacement is current; the first one recorded wins", () => {
  const s = (observation: string, by: string) =>
    ({ by, observation }) as Supersession;
  const list = [s("A", "gone"), s("A", "B"), s("A", "C"), s("D", "gone")];
  const retired = retiredBy(list, new Set(["B", "C"]));
  expect([...retired].map(([id, x]) => [id, x.by])).toEqual([["A", "B"]]);
});

test("a claim he rated false or partly is hidden as wrong, with his why, until an undo or a later answer takes it back", () => {
  const at = "2026-10-19T08:00:00Z";
  const rate = (claim: string, answer: Rating["answer"], note?: string) =>
    ({ answer, at, note, ref: claim, schemaVersion: 1 }) as Rating;
  const wrong = ratedCorrections(
    latestRatings([
      rate("obs_a", "false"),
      rate("obs_b", "false"),
      rate("obs_b", null),
      rate("obs_c", "false"),
      rate("obs_c", "true"),
      rate("ep_d", "skip"),
      rate("ep_e", "false"),
      rate("obs_f", "partly", "it was Tuesday, not Monday"),
    ])
  );
  expect(
    wrong.flatMap((c) => (c.kind === "wrong" ? c.observations : []))
  ).toEqual(["obs_a", "ep_e", "obs_f"]);
  expect(wrong.map((c) => c.note)).toEqual([
    "rated false",
    "rated false",
    "rated partly: it was Tuesday, not Monday",
  ]);
});

test("audit-7-close-kept-promise: a promise he says he kept is retired by itself with his words, as history, not wrong or hidden", () => {
  const kept = {
    at: "2026-10-27T14:50:00Z",
    kind: "outdated",
    note: "it's already done",
    observations: ["obs_a"],
    schemaVersion: 1,
  } as Correction;
  const s = {
    corrections: [kept],
    latest: new Map(),
    live: new Set(["unit_1"]),
    retired: retiredBy(outdatedBy([kept]), new Set(["obs_a"])),
  } as Standing;
  expect(stateOf(obs("obs_a", "unit_1", "h1"), s)).toEqual({
    at: "2026-10-27T14:50:00Z",
    by: "obs_a",
    hiddenOn: [],
    page: undefined,
    state: "retired",
    validTo: "2026-10-27",
    why: "it's already done",
  });
});

test("a claim he rated outdated is retired by itself, as history, not wrong; an undo lifts it, extraction's retirement wins", () => {
  const rate = (claim: string, answer: Rating["answer"]) =>
    ({
      answer,
      at: "2026-10-19T08:00:00Z",
      ref: claim,
      schemaVersion: 1,
    }) as Rating;
  const x = obs("obs_a", "unit_1", "h1");
  const standing = (ratings: Rating[], first: Supersession[] = []) =>
    ({
      corrections: [],
      latest: new Map(),
      live: new Set(["unit_1"]),
      retired: retiredBy(
        [...first, ...outdatedBy(ratedCorrections(latestRatings(ratings)))],
        new Set(["obs_a", "obs_b"])
      ),
    }) as Standing;
  const outdated = standing([rate("obs_a", "outdated")]);
  expect(stateOf(x, outdated)).toEqual({
    at: "2026-10-19T08:00:00Z",
    by: "obs_a",
    hiddenOn: [],
    page: undefined,
    state: "retired",
    validTo: "2026-10-19",
    why: "rated outdated",
  });
  expect(
    ratedCorrections(latestRatings([rate("obs_a", "outdated")])).map(
      (c) => c.kind
    )
  ).toEqual(["outdated"]);
  expect(
    stateOf(x, standing([rate("obs_a", "outdated"), rate("obs_a", null)])).state
  ).toBe("active");
  const closed = { by: "obs_b", observation: "obs_a" } as Supersession;
  expect(
    stateOf(x, standing([rate("obs_a", "outdated")], [closed]))
  ).toMatchObject({ by: "obs_b", state: "retired" });
});

test("a fact check is rated only once he was shown it, with his why; the eval reads partly and skip as nothing, outdated as true", async () => {
  const shown = (ref: string) => ({
    at: "2026-10-29T21:00:00Z",
    date: "2026-10-28",
    group: "episodes" as const,
    kind: "fact" as const,
    ref,
    schemaVersion: 1 as const,
    source: null,
    text: `fact ${ref}`,
    units: ["unit_000000000000"],
  });
  const [right, half, old, passed] = [
    "obs_fac700000001",
    "obs_fac700000002",
    "obs_fac700000003",
    "obs_fac700000004",
  ] as const;
  await appendJsonl(STATEMENTS, Statement, [
    shown(right),
    shown(half),
    shown(old),
    shown(passed),
  ]);
  expect(() => recordRating("obs_fac700000009", "true")).toThrow(
    "no fact check"
  );
  await recordRating(right, "true");
  await recordRating(half, "partly", "it was Tuesday");
  await recordRating(old, "outdated");
  await recordRating(passed, "skip");
  expect(readRatings().get(half)?.note).toBe("it was Tuesday");
  const facts = new Map(ratedFacts().map((f) => [f.id, f]));
  expect([right, half, old, passed].map((r) => facts.get(r)?.true)).toEqual([
    true,
    undefined,
    true,
    undefined,
  ]);
  expect(facts.get(old)?.outdated).toBe(true);
});

test("a unit by id is read from its day (the index says which), or from every day when the index doesn't hold it; a standing from origins is the standing from observations", async () => {
  const indexed = unitFixture({ date: "2026-10-20", id: "unit_00000000000a" });
  const newer = unitFixture({ date: "2026-10-21", id: "unit_00000000000b" });
  mkdirSync(UNITS, { recursive: true });
  mkdirSync(dirname(INDEX), { recursive: true });
  try {
    for (const u of [indexed, newer]) {
      writeFileSync(join(UNITS, `${u.date}.jsonl`), `${JSON.stringify(u)}\n`);
    }
    const standing = {
      corrections: [],
      latest: new Map(),
      live: new Set<string>(),
      retired: new Map(),
    };
    buildIndex([], INDEX, standing, [{ unit: indexed }]);
    expect(await readUnit(indexed.id)).toEqual(indexed);
    expect(await readUnit(newer.id)).toEqual(newer);
    expect(await readUnit("unit_00000000000c")).toBeUndefined();
    const fact = (id: string, unitId: string): Observation => ({
      area: null,
      at: "2026-10-20T10:00:00.000Z",
      confidence: 1,
      date: "2026-10-20",
      entities: [],
      id,
      importance: 2,
      madeBy: { ...madeBy, unitHash: indexed.hash },
      quote: "q",
      schemaVersion: 1,
      source: { channel: "lifelog", ref: "j:0@x" },
      speaker: "person:me",
      text: "t",
      type: "to_do",
      tz: "UTC",
      unit: unitId,
      validFrom: null,
      validTo: null,
      when: null,
    });
    const facts = [
      fact("obs_00000000000a", indexed.id),
      fact("obs_00000000000b", "unit_0000000000ff"),
    ];
    mkdirSync(OBSERVATIONS, { recursive: true });
    writeFileSync(
      join(OBSERVATIONS, "2026-10.jsonl"),
      `${facts.map((o) => JSON.stringify(o)).join("\n\n")}\n`
    );
    const origins = await readOrigins();
    expect(origins.get("2026-10.jsonl")?.map((o) => o.n)).toEqual([0, 2]);
    expect(await readStanding([])).toEqual(
      await readStanding([], Promise.resolve(facts))
    );
  } finally {
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(OBSERVATIONS, { force: true, recursive: true });
    rmSync(INDEX, { force: true });
  }
});
