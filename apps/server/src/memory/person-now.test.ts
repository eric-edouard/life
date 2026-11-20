import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OWNER_DATA_DIR } from "../core/paths";
import type { SourceEvent } from "../records/source";
import type { Unit } from "../records/unit";
import { buildIndex } from "./index-writer";
import { INDEX, INFERRED, UNITS } from "./memory-files";
import {
  firstSentenceOf,
  knowsOf,
  type MatterRowNow,
  type PersonRow,
  peopleListOf,
  personNowOf,
  rowOf,
} from "./person-now";
import { PART_CHARS } from "./read-part";
import { person } from "./read-person-page";
import { unit as unitFixture } from "./record-fixtures";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as sources from "./sources";

// Made-up people, organizations and chats only (test-data/truth: Test Owner, Test Ana, Test Bakery).

afterEach(() => {
  rmSync(INDEX, { force: true });
  rmSync(UNITS, { force: true, recursive: true });
  rmSync(INFERRED, { force: true });
});

const party = (ref: string, name: string) => ({
  kind: "person" as const,
  name,
  ref,
});
const row = (ref: string, level?: PersonRow["level"], at?: string) => ({
  ...party(ref, ref.slice(7)),
  ...(at ? { lastExchangeAt: at } : {}),
  ...(level ? { level } : {}),
  needsYou: false,
});
const matter = (n: number, over: Partial<MatterRowNow> = {}): MatterRowNow => ({
  blockingChecks: 0,
  id: `matter_${String(n).padStart(12, "0")}`,
  name: `Matter ${n}: ${"an errand with a long name ".repeat(4)}`,
  needsYou: false,
  people: { with: [party("person:ana", "Ana")] },
  status: "moving",
  ...over,
});

test("the list: by level, inner first, the unjudged after all four; inside a level the newest exchange first", () => {
  const list = peopleListOf([
    row("person:zed"),
    row("person:old", "faded", "2026-11-19T10:00:00.000Z"),
    row("person:bo", "regular", "2026-10-01T10:00:00.000Z"),
    row("person:cy", "regular", "2026-11-01T10:00:00.000Z"),
    row("person:ana", "inner"),
    row("person:dee", "acquaintance"),
  ]);
  expect(list.map((r) => r.ref.slice(7))).toEqual([
    "ana",
    "cy",
    "bo",
    "dee",
    "old",
    "zed",
  ]);
});

test("a row: the closer of its two levels, its last exchange, and needsYou from any of its running matters", () => {
  const standing = {
    lastExchangeAt: () => "2026-11-18T10:00:00.000Z",
    levelOf: () => ({ personal: "faded" as const, work: "regular" as const }),
  };
  const ana = party("person:ana", "Ana");
  expect(rowOf(ana, standing, [matter(1)])).toEqual({
    ...ana,
    lastExchangeAt: "2026-11-18T10:00:00.000Z",
    level: "regular",
    needsYou: false,
  });
  expect(
    rowOf(ana, standing, [matter(1), matter(2, { needsYou: true })]).needsYou
  ).toBe(true);
  // A matter that needs him but is someone else's is not hers.
  expect(
    rowOf(ana, { lastExchangeAt: () => undefined, levelOf: () => undefined }, [
      matter(3, {
        needsYou: true,
        people: { owedTo: [party("person:bo", "Bo")] },
      }),
    ])
  ).toEqual({ ...ana, needsYou: false });
});

test("`now` holds under PART_CHARS with hundreds of open matters, the top-ranked first, and counts the rest", () => {
  const matters = Array.from({ length: 300 }, (_, i) => matter(i));
  const now = personNowOf({
    communicationStyle: [],
    details: [
      { from: "truth", kind: "birthday", text: "--03-12" },
      { from: "truth", kind: "handles", text: "+33600000001" },
      { from: "contacts", kind: "handles", text: "Facebook: ana.t" },
    ],
    episodes: [{ month: "2026-11", titles: ["A walk"] }],
    knows: [],
    matters,
    reach: [
      {
        accounts: [
          {
            handle: "+33 6 00 00 00 01",
            open: { lands: "chat", url: "https://wa.me/33600000001" },
          },
        ],
        label: "WhatsApp",
        network: "whatsapp",
      },
    ],
    row: row("person:me"),
    situation: [{ cites: ["ep_000000000001"], text: "Busy with the move." }],
    today: "2026-03-10",
  });
  expect(JSON.stringify(now).length).toBeLessThanOrEqual(PART_CHARS);
  expect(now.open[0]?.id).toBe(matters[0]?.id);
  expect(now.open.length + (now.moreMatters ?? 0)).toBe(300);
  expect(now.moreMatters).toBeGreaterThan(0);
  // A birthday dated; a handle the reach already opens is not a detail again.
  expect(now.details).toEqual([
    {
      from: "truth",
      kind: "birthday",
      next: { age: null, day: "2026-03-12", left: 2 },
      text: "--03-12",
    },
    { from: "contacts", kind: "handles", text: "Facebook: ana.t" },
  ]);
  const few = personNowOf({ ...now, ...inputsOf(now), matters: [matter(1)] });
  expect(few.moreMatters).toBeUndefined();
});

/** `now`'s inputs back from a `now` (a second read of the same person). */
const inputsOf = (now: ReturnType<typeof personNowOf>) => ({
  communicationStyle: now.communicationStyle,
  details: [],
  episodes: now.episodes,
  knows: now.knows,
  reach: now.reach,
  row: row(now.ref),
  situation: now.situation,
  today: "2026-03-10",
});

test("knows: each part that holds something, with its ref and first sentence; an empty part is left out", () => {
  expect(
    firstSentenceOf([
      "(page built 2026-11-18 03:00 UTC: newer observations are in the evidence, not on it yet)",
      "# Ana\n\n## Now\n- Ana runs the bakery. She opens at six.",
    ])
  ).toBe("Ana runs the bakery.");
  expect(firstSentenceOf(["Evidence:", "Observations:", "(none)"])).toBe(
    undefined
  );
  const read = (part: "page" | "persona") => ({
    ref: { part, subject: "person:ana" },
  });
  expect(
    knowsOf([read("page"), read("persona")], (p) =>
      p === "page" ? ["Who she is, in short. More."] : ["(no persona yet)"]
    )
  ).toEqual([
    { first: "Who she is, in short.", part: "page", ref: "person:ana/page" },
  ]);
});

const indexed = (units: Unit[]) => {
  mkdirSync(dirname(INDEX), { recursive: true });
  mkdirSync(UNITS, { recursive: true });
  for (const u of units) {
    writeFileSync(join(UNITS, `${u.date}.jsonl`), `${JSON.stringify(u)}\n`);
  }
  buildIndex(
    [],
    INDEX,
    {
      corrections: [],
      live: new Set(),
      retired: new Map(),
      standing: new Map(),
    },
    units.map((unit) => ({ unit }))
  );
};

test("the read with no name: his directory's people and organizations, him left out; a query's matches and its others", async () => {
  indexed([]);
  writeFileSync(
    INFERRED,
    `${JSON.stringify({
      area: null,
      at: "2026-11-12T03:00:00.000Z",
      confidence: 0.9,
      evidence: [{ quote: "hello there", unit: "unit_1" }],
      id: "inf_test-anna",
      madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
      name: "Test Anna",
      namesAndHandles: ["Test Anna"],
      person: null,
      project: null,
      relation: "a neighbour",
      schemaVersion: 1,
    })}\n`
  );
  const all = (await person()) as { people: PersonRow[] };
  const refs = all.people.map((r) => r.ref);
  expect(refs).toContain("person:test-ana");
  expect(refs).toContain("person:test-bakery");
  expect(refs).not.toContain("person:me");
  expect(all.people.find((r) => r.ref === "person:test-bakery")).toMatchObject({
    kind: "organization",
    needsYou: false,
  });
  const found = (await person(undefined, { query: "test ana" })) as {
    others: { ref: string }[];
    people: PersonRow[];
  };
  expect(found.people.map((r) => r.ref)).toEqual(["person:test-ana"]);
  expect(found.others.map((p) => p.ref)).toEqual(["person:inf_test-anna"]);
  expect(
    (
      (await person(undefined, { query: "the bakery" })) as {
        people: PersonRow[];
      }
    ).people.map((r) => r.ref)
  ).toEqual(["person:test-bakery"]);
});

test("`now` of a person and of an organization: their row, reach and open matters; an organization's people and domains", async () => {
  indexed([]);
  const theirs = matter(1, {
    needsYou: true,
    people: { with: [party("person:test-ana", "Test Ana")] },
  });
  const ana = (await person("Test Ana", {}, {}, () =>
    Promise.resolve([theirs, matter(2)])
  )) as Record<string, unknown>;
  expect(ana).toMatchObject({
    kind: "person",
    name: "Test Ana",
    needsYou: true,
    open: [{ id: theirs.id }],
    ref: "person:test-ana",
  });
  expect(ana.line).toBe("baker, Test Bakery");
  const bakery = (await person("Test Bakery")) as Record<string, unknown>;
  expect(bakery).toMatchObject({
    domains: ["bakery.example"],
    kind: "organization",
    people: [{ party: { ref: "person:test-ana" }, role: "baker" }],
    reach: [
      {
        accounts: [{ handle: "hello@bakery.example" }],
        network: "mail",
      },
    ],
  });
});

test("the edge cases of `now`: a name no one goes by says so with the parties near it", async () => {
  indexed([]);
  expect(await person("Test Anx")).toEqual({
    near: [expect.objectContaining({ ref: "person:test-ana" })],
    noOne: "Test Anx",
  });
});

test("latest: their newest 1:1 exchanges, five a page by whole days, through one index read a round; before pages back", async () => {
  const chat = "33600000001@s.whatsapp.net";
  const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;
  const units = Array.from({ length: 8 }, (_, i) =>
    unitFixture({
      date: day(i + 1),
      end: `${day(i + 1)}T10:05:00.000Z`,
      id: `unit_${String(i + 1).padStart(12, "0")}`,
      key: chat,
      people: ["person:test-ana", "person:me"],
      source: "whatsapp",
      start: `${day(i + 1)}T10:00:00.000Z`,
      title: "Ana B",
    })
  );
  const said = (d: string, fromMe: boolean, text: string): SourceEvent => ({
    at: `${d}T10:0${fromMe ? 1 : 0}:00.000Z`,
    chat,
    chatName: "Ana B",
    fromMe,
    id: `whatsapp:${chat}/${d}${fromMe}`,
    sender: fromMe ? "me" : "+33600000001",
    source: "whatsapp",
    text,
  });
  const real = sources.sourceOf;
  const spy = spyOn(sources, "sourceOf").mockImplementation(
    (name) =>
      ({
        ...real(name),
        read: (since: Date) => {
          const d = since.toISOString().slice(0, 10);
          return [said(d, false, `Hello on ${d}`), said(d, true, "Hi")];
        },
      }) as never
  );
  try {
    indexed(units);
    const first = (await person("Test Ana", { part: "latest" })) as {
      latest: {
        at: string;
        channel: string;
        lines: unknown[];
        open?: unknown;
      }[];
      nextBefore?: string;
    };
    expect(first.latest.map((x) => x.at.slice(0, 10))).toEqual([
      day(8),
      day(7),
      day(6),
      day(5),
      day(4),
    ]);
    expect(first.latest[0]).toEqual({
      at: `${day(8)}T10:00:00.000Z`,
      channel: "whatsapp",
      lines: [
        { by: "them", text: `Hello on ${day(8)}` },
        { by: "him", text: "Hi" },
      ],
      open: { lands: "chat", url: "https://wa.me/33600000001" },
    });
    expect(first.nextBefore).toBe(day(4));
    const second = (await person("Test Ana", {
      before: first.nextBefore,
      part: "latest",
    })) as typeof first;
    expect(second.latest.map((x) => x.at.slice(0, 10))).toEqual([
      day(3),
      day(2),
      day(1),
    ]);
    expect(second.nextBefore).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

test("the edge cases of `now`: a name two go by gives them as candidates, and the first's `now`", async () => {
  indexed([]);
  const file = join(OWNER_DATA_DIR, "truth", "people.yaml");
  const was = readFileSync(file, "utf8");
  writeFileSync(
    file,
    `${was}  - id: test-ana-two\n    name: Ana Two\n    aliases: [Test Ana]\n`
  );
  try {
    const read = (await person("Test Ana")) as {
      candidates: { ref: string }[];
      now: { ref: string };
    };
    expect(read.candidates.map((p) => p.ref)).toEqual([
      "person:test-ana",
      "person:test-ana-two",
    ]);
    expect(read.now.ref).toBe("person:test-ana");
  } finally {
    writeFileSync(file, was);
  }
});
