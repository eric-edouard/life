import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Correction,
  Extracted,
  Observation,
  Rating,
  Supersession,
} from "../schema";
import {
  isCurrent,
  latestExtractions,
  latestRatings,
  newSince,
  ratedFalse,
  ratedOutdated,
  ratedTrue,
  retiredBy,
  type Standing,
  shownOf,
  stateOf,
} from "./ledger";
import { knownOn } from "./page";
import { buildIndex } from "./search";

const obs = (id: string, unit: string, unitHash: string, run = "r1") =>
  ({ id, madeBy: { run, unitHash }, unit }) as Observation;
const read = (unit: string, unitHash: string, run = "r1") =>
  ({ run, unit, unitHash }) as Extracted;

test("a unit re-extracted under another hash or prompt keeps only its latest facts; a unit never extracted keeps all; a gone or dropped unit none", () => {
  const all = [
    obs("old", "u_1", "h1"),
    obs("new", "u_1", "h2"),
    obs("other", "u_2", "h1"),
    obs("loose", "u_3", "h1"),
    obs("v1", "u_4", "h1"),
    obs("v2", "u_4", "h1", "r2"),
    obs("cut", "u_5", "h1"),
  ];
  const ledger = [
    read("u_1", "h1"),
    read("u_2", "h1"),
    read("u_1", "h2"),
    read("u_4", "h1"),
    read("u_4", "h1", "r2"),
  ];
  const c = {
    latest: latestExtractions(ledger),
    live: new Set(["u_1", "u_2", "u_3", "u_4"]),
    rated: new Set<string>(),
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
    ({ ...obs(id, "u_chat", "h", run), source: { ref } }) as Observation;
  const LAST = "2026-10-17T02-00-10.000Z";
  const NOON = "2026-10-17T13-00-10.000Z";
  const TONIGHT = "2026-10-18T02-00-10.000Z";
  const all = [
    cites("ask", "msg_ask", LAST),
    // Tonight's re-read of the same chat-day: the same fact re-made, and one re-worded, from the line already cited.
    cites("ask", "msg_ask", TONIGHT),
    cites("ask-reworded", "msg_ask", TONIGHT),
    // A midday run's line counts in tonight's report; so does the message the chat-day grew by.
    cites("noon", "msg_noon", NOON),
    cites("reply", "msg_reply", TONIGHT),
  ];
  expect(
    all.filter(newSince(all, "2026-10-17T02:04:00.000Z")).map((o) => o.id)
  ).toEqual(["noon", "reply"]);
  expect(all.filter(newSince(all))).toHaveLength(5);
});

// Where each observation stands, as the index, a page and the dashboard see it. The fixture covers every rule: hidden
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
  extracted: [read("u_1", "h1"), read("u_2", "h1"), read("u_2", "h2", "r2")],
  list: [
    line("A", "u_1"),
    line("B", "u_1"),
    line("C", "u_1"),
    line("D", "u_2"),
    line("D", "u_2", "h2", "r2"),
    line("E", "u_2", "h2", "r2"),
    line("R", "u_2", "h2", "r2"),
    line("L", "u_9"),
    line("G", "u_8"),
    line("O", "u_1"),
  ],
  live: new Set(["u_1", "u_2", "u_9"]),
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
    ratedOutdated(
      latestRatings([
        { answer: "outdated", at: "2026-10-19T08:00:00Z", claim: "O" },
      ] as Rating[])
    )[0] as Supersession
  ),
};

test("the index, the pages and the dashboard agree on where each observation stands", async () => {
  const { index, onPage, dashboard } = await view(fixture);
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
  expect(dashboard).toEqual([
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

/** The fixture as each reader takes it: `observationsNow` and `buildIndex`, a page (`knownOn`), the dashboard. */
async function view(f: typeof fixture) {
  const standing = {
    corrections: f.corrections,
    latest: latestExtractions(f.extracted),
    live: f.live,
    rated: new Set<string>(),
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
  const dashboard = f.list.map((x) => {
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
  return { dashboard, index, onPage };
}

test("hidden beats gone beats replaced beats retired beats active", () => {
  const x = obs("obs_000000000001", "u_1", "h1");
  const at = (over: Partial<Standing>): Standing => ({
    corrections: [],
    latest: new Map(),
    live: new Set(["u_1"]),
    rated: new Set(),
    retired: new Map(),
    ...over,
  });
  const wrong = (page?: string) =>
    ({ at: "t", kind: "wrong", observations: [x.id], page }) as Correction;
  const retired = new Map([
    [x.id, { at: "t", by: "obs_000000000002" } as Supersession],
  ]);
  const latest = new Map([["u_1", read("u_1", "other", "r2")]]);
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

test("a retirement stands only while its replacement is current; the first one recorded wins", () => {
  const s = (observation: string, by: string) =>
    ({ by, observation }) as Supersession;
  const list = [s("A", "gone"), s("A", "B"), s("A", "C"), s("D", "gone")];
  const retired = retiredBy(list, new Set(["B", "C"]));
  expect([...retired].map(([id, x]) => [id, x.by])).toEqual([["A", "B"]]);
});

test("a claim he rated false is hidden as wrong until an undo or a later answer takes it back", () => {
  const at = "2026-10-19T08:00:00Z";
  const rate = (claim: string, answer: Rating["answer"]) =>
    ({ answer, at, claim, schemaVersion: 1 }) as Rating;
  const wrong = ratedFalse(
    latestRatings([
      rate("obs_a", "false"),
      rate("obs_b", "false"),
      rate("obs_b", null),
      rate("obs_c", "false"),
      rate("obs_c", "true"),
      rate("mom_d", "skip"),
      rate("mom_e", "false"),
    ])
  );
  expect(
    wrong.flatMap((c) => (c.kind === "wrong" ? c.observations : []))
  ).toEqual(["obs_a", "mom_e"]);
});

test("a claim he rated outdated is retired by itself, as history, not wrong; an undo lifts it, extraction's retirement wins", () => {
  const rate = (claim: string, answer: Rating["answer"]) =>
    ({ answer, at: "2026-10-19T08:00:00Z", claim, schemaVersion: 1 }) as Rating;
  const x = obs("obs_a", "u_1", "h1");
  const standing = (ratings: Rating[], first: Supersession[] = []) =>
    ({
      corrections: [],
      latest: new Map(),
      live: new Set(["u_1"]),
      rated: new Set(),
      retired: retiredBy(
        [...first, ...ratedOutdated(latestRatings(ratings))],
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
  expect(ratedFalse(latestRatings([rate("obs_a", "outdated")]))).toEqual([]);
  expect(
    stateOf(x, standing([rate("obs_a", "outdated"), rate("obs_a", null)])).state
  ).toBe("active");
  const closed = { by: "obs_b", observation: "obs_a" } as Supersession;
  expect(
    stateOf(x, standing([rate("obs_a", "outdated")], [closed]))
  ).toMatchObject({ by: "obs_b", state: "retired" });
});

test("a re-read keeps a fact he rated true: not replaced when the new reading leaves it out, retired only by a newer fact", () => {
  const rate = (answer: Rating["answer"]) =>
    ({
      answer,
      at: "2026-10-19T08:00:00Z",
      claim: "obs_a",
      schemaVersion: 1,
    }) as Rating;
  const rated = obs("obs_a", "u_1", "h1");
  const other = obs("obs_b", "u_1", "h1");
  // u_1 was read again by a later run, which wrote neither fact again.
  const latest = new Map([["u_1", read("u_1", "h1", "r2")]]);
  const standing = (
    ratings: Rating[],
    retired = new Map<string, Supersession>()
  ) =>
    ({
      corrections: [],
      latest,
      live: new Set(["u_1"]),
      rated: ratedTrue(latestRatings(ratings)),
      retired,
    }) as Standing;
  expect(stateOf(rated, standing([rate("true")])).state).toBe("active");
  expect(stateOf(other, standing([rate("true")])).state).toBe("replaced");
  // An undo or a later answer lifts it.
  expect(stateOf(rated, standing([rate("true"), rate(null)])).state).toBe(
    "replaced"
  );
  const by = new Map([["obs_a", { at: "t", by: "obs_c" } as Supersession]]);
  expect(stateOf(rated, standing([rate("true")], by)).state).toBe("retired");
});

test("a fact he rated true and a re-read wrote again word for word shows once, its latest line; one he rated outdated keeps its history", () => {
  const rate = (claim: string, answer: Rating["answer"]) =>
    ({ answer, at: "2026-10-19T08:00:00Z", claim, schemaVersion: 1 }) as Rating;
  const again = obs("obs_a", "u_1", "h1", "r2");
  const latest = new Map([["u_1", read("u_1", "h1", "r2")]]);
  const ratings = latestRatings([
    rate("obs_a", "true"),
    rate("obs_o", "outdated"),
  ]);
  const rated = ratedTrue(ratings);
  const standing = {
    corrections: [],
    latest,
    live: new Set(["u_1"]),
    rated,
    retired: retiredBy(ratedOutdated(ratings), new Set(["obs_o"])),
  } as Standing;
  expect(
    shownOf([obs("obs_a", "u_1", "h1"), again], standing).map(
      (o) => o.madeBy.run
    )
  ).toEqual(["r2"]);
  expect(stateOf(obs("obs_o", "u_1", "h1"), standing).state).toBe("retired");
});
