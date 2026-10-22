import { expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { momentId } from "../memory/moments";
import { observationId } from "../memory/observe";
import { lineHash } from "../memory/page-format";
import {
  action,
  madeBy,
  unit as unitRecord,
  verdict as verdictRecord,
} from "../memory/record-fixtures";
import { unitId } from "../memory/units";
import { LedgerEntry } from "../records/ledger-entry";
import { InferredPerson, Observation } from "../records/observation";
import { Rating, Statement } from "../records/statement";
import { MemoryLabel, Unit, Verdict } from "../records/unit";
import { entryId } from "./act";
import { migrateStored, relabeled, renameStored } from "./migrate";

// Made-up memory as it was written before the rename: old ids minted by the old recipes, old keys and values.
const old = (id: string) => `u_${id.slice(5)}`;
const chat = old(
  unitId("whatsapp", "33600000000@s.whatsapp.net", "2026-10-20")
);
const ask = "act_0123456789ab";
const agentUnit = old(unitId("atlas", ask, "2026-10-20"));
const quote = "Je passe demain, u_000000000000 compris";
const obs = `obs_${observationId(chat, "todo", quote, "Lou comes by tomorrow.").slice(4)}`;
const mom = momentId(["2026-10-20", "2026-10-20 18:00", chat]);
const line = `- Lou comes by tomorrow. [${obs}]`;

const jsonl = (...lines: object[]) =>
  `${lines.map((r) => JSON.stringify(r)).join("\n")}\n`;
const before = new Map([
  [
    "memory/units/2026-10-20.jsonl",
    jsonl(
      {
        date: "2026-10-20",
        id: chat,
        key: "33600000000@s.whatsapp.net",
        source: "whatsapp",
      },
      {
        date: "2026-10-20",
        id: agentUnit,
        key: ask,
        refs: [`atlas:${ask}`],
        source: "atlas",
      }
    ),
  ],
  [
    "memory/verdicts.jsonl",
    jsonl(
      { salience: 2, type: "waiting", unit: chat },
      { salience: 3, type: "person", unit: agentUnit }
    ),
  ],
  [
    "memory/observations/2026-10.jsonl",
    jsonl({
      entities: ["person:inf-plumber"],
      id: obs,
      quote,
      salience: 2,
      source: { channel: "whatsapp", ref: "whatsapp:x/1" },
      text: "Lou comes by tomorrow.",
      type: "todo",
      unit: chat,
    }),
  ],
  [
    "memory/moments/2026-10-20.jsonl",
    jsonl({
      day: "2026-10-20",
      id: mom,
      start: "2026-10-20 18:00",
      title: "Lou",
      units: [chat],
    }),
  ],
  [
    "memory/actions.jsonl",
    jsonl(
      { id: ask, kind: "ask", madeBy: "watch", target: "atlas" },
      {
        id: "act_00000000000b",
        kind: "update",
        madeBy: "connector",
        target: ask,
      },
      {
        id: "act_00000000000c",
        instruction: { ref: obs },
        kind: "add",
        madeBy: "session",
        target: "reminder:1",
      }
    ),
  ],
  ["memory/statements.jsonl", jsonl({ claim: obs, units: [chat] })],
  ["memory/ratings.jsonl", jsonl({ answer: "true", claim: mom })],
  ["memory/labels.jsonl", jsonl({ matters: true, type: "todo", unitId: chat })],
  [
    "memory/people-inferred.jsonl",
    jsonl({
      evidence: [{ quote: "inf-plumber", unit: chat }],
      id: "inf-plumber",
    }),
  ],
  [
    "memory/corrections.jsonl",
    jsonl(
      { kind: "wrong", observations: [obs, mom] },
      { kind: "reread", units: [chat] }
    ),
  ],
  [
    "memory/pages/people/inf-plumber.md",
    `---\npage: "person:inf-plumber"\nlines: ${JSON.stringify({ [lineHash(line)]: [obs] })}\n---\n## Now\n${line}\n- His own line.\n`,
  ],
  [
    "memory/zones.jsonl",
    jsonl({ from: "2026-01-01T00:00:00Z", tz: "Europe/Paris" }),
  ],
]);

const { files, moves } = renameStored(before);
const after = new Map([...before, ...files]);
const rows = (path: string) =>
  (after.get(path) ?? "")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

const unit = `unit_${chat.slice(2)}`;
const newObs = observationId(unit, "to_do", quote, "Lou comes by tomorrow.");
const newMom = momentId(["2026-10-20", "2026-10-20 18:00", unit]);

test("ids are renamed as the code now mints them, so a later reading finds the same ones", () => {
  const [u, agent] = rows("memory/units/2026-10-20.jsonl");
  expect(u.id).toBe(unit);
  expect(agent).toMatchObject({
    id: unitId("agent", "entry_0123456789ab", "2026-10-20"),
    key: "entry_0123456789ab",
    refs: ["agent:entry_0123456789ab"],
    source: "agent",
  });
  expect(rows("memory/observations/2026-10.jsonl")[0].id).toBe(newObs);
  expect(rows("memory/moments/2026-10-20.jsonl")[0]).toMatchObject({
    id: newMom,
    units: [unit],
  });
  expect(rows("memory/corrections.jsonl")).toMatchObject([
    { observations: [newObs, newMom] },
    { units: [unit] },
  ]);
});

test("keys and values take their new names; quotes keep the source's own words", () => {
  const [o] = rows("memory/observations/2026-10.jsonl");
  expect(o).toMatchObject({
    entities: ["person:inf_plumber"],
    importance: 2,
    quote,
    type: "to_do",
  });
  expect(o.salience).toBeUndefined();
  expect(rows("memory/verdicts.jsonl")).toMatchObject([
    { importance: 2, type: "waiting_on_someone", unit },
    {
      type: "about_a_person",
      unit: rows("memory/units/2026-10-20.jsonl")[1].id,
    },
  ]);
  expect(rows("memory/actions.jsonl")).toMatchObject([
    { id: "entry_0123456789ab", target: "agent", via: "watch" },
    {
      id: "entry_00000000000b",
      target: "entry_0123456789ab",
      via: "connector",
    },
    { instruction: { ref: newObs }, via: "session" },
  ]);
  expect(rows("memory/statements.jsonl")[0]).toEqual({
    ref: newObs,
    units: [unit],
  });
  expect(rows("memory/ratings.jsonl")[0]).toEqual({
    answer: "true",
    ref: newMom,
  });
  expect(rows("memory/labels.jsonl")[0]).toEqual({
    matters: true,
    type: "to_do",
    unitId: unit,
  });
  expect(rows("memory/people-inferred.jsonl")[0]).toEqual({
    evidence: [{ quote: "inf-plumber", unit }],
    id: "inf_plumber",
  });
});

test("a page's ids and line hashes move together; his own lines stay word for word", () => {
  const page = after.get("memory/pages/people/inf-plumber.md") ?? "";
  const moved = `- Lou comes by tomorrow. [${newObs}]`;
  expect(page).toContain('page: "person:inf_plumber"');
  expect(page).toContain(
    `lines: ${JSON.stringify({ [lineHash(moved)]: [newObs] })}`
  );
  expect(page).toContain(`${moved}\n- His own line.\n`);
});

test("every line keeps its place; the ledger and an inferred person's page move; the rest is untouched", () => {
  for (const [path, text] of files) {
    expect(text.split("\n").length).toBe(
      before.get(path)?.split("\n").length ?? -1
    );
  }
  expect(moves).toEqual([
    ["memory/actions.jsonl", "memory/ledger.jsonl"],
    [
      "memory/pages/people/inf-plumber.md",
      "memory/pages/people/inf_plumber.md",
    ],
  ]);
  expect(files.has("memory/zones.jsonl")).toBe(false);
});

test("run again on renamed data, it changes nothing", () => {
  const again = renameStored(after);
  expect([...again.files.keys()]).toEqual([]);
});

// Records as the new code writes them, aged into the old names, renamed back: the same records, and each parses.
const AT = "2026-10-20T08:00:00.000Z";
const observation = {
  about: "person:inf_plumber",
  area: null,
  at: AT,
  confidence: 0.8,
  date: "2026-10-20",
  entities: ["person:inf_plumber"],
  id: "obs_00000000000a",
  importance: 2,
  madeBy: { ...madeBy, unitHash: "0123456789abcdef" },
  quote: "je passe demain",
  schemaVersion: 1,
  source: { channel: "whatsapp", ref: "whatsapp:x/1" },
  speaker: "agent:agent",
  speakerFrom: "agent",
  text: "The plumber comes by tomorrow.",
  type: "waiting_on_someone",
  tz: "Europe/Paris",
  unit: "unit_00000000000a",
  validFrom: null,
  validTo: null,
  when: null,
};
const records: [string, z.ZodType, object][] = [
  [
    "memory/units/2026-10-09.jsonl",
    Unit,
    unitRecord({ refs: ["agent:entry_0123456789ab"], source: "agent" }),
  ],
  [
    "memory/verdicts.jsonl",
    Verdict,
    verdictRecord(unitRecord(), { type: "about_a_person" }),
  ],
  ["memory/observations/2026-10.jsonl", Observation, observation],
  [
    "memory/actions.jsonl",
    LedgerEntry,
    action({ target: "agent", via: "watch" }),
  ],
  [
    "memory/statements.jsonl",
    Statement,
    {
      at: AT,
      date: "2026-10-20",
      group: "person:inf_plumber",
      kind: "fact",
      ref: "obs_00000000000a",
      schemaVersion: 1,
      source: "whatsapp",
      text: "The plumber comes by tomorrow.",
      units: ["unit_00000000000a"],
    },
  ],
  [
    "memory/ratings.jsonl",
    Rating,
    { answer: "true", at: AT, ref: "mom_00000000000a", schemaVersion: 1 },
  ],
  [
    "memory/labels.jsonl",
    MemoryLabel,
    { matters: true, type: "to_do", unitId: "unit_00000000000a" },
  ],
  [
    "memory/people-inferred.jsonl",
    InferredPerson,
    {
      area: null,
      at: AT,
      confidence: 0.7,
      evidence: [{ quote: "je passe demain", unit: "unit_00000000000a" }],
      id: "inf_plumber",
      madeBy,
      name: "The plumber",
      project: null,
      relation: "fixes the sink",
      schemaVersion: 1,
      surfaces: ["+33600000000"],
    },
  ],
];
const SALIENCE = /verdicts|observations/;
const CLAIMED = /statements|ratings/;
const aged = (path: string, r: object) => {
  let s = JSON.stringify(r)
    .replaceAll("unit_", "u_")
    .replaceAll("entry_", "act_")
    .replaceAll("inf_", "inf-")
    .replaceAll('"agent"', '"atlas"')
    .replaceAll("agent:agent", "agent:atlas")
    .replaceAll("agent:act_", "atlas:act_")
    .replaceAll('"to_do"', '"todo"')
    .replaceAll('"waiting_on_someone"', '"waiting"')
    .replaceAll('"about_a_person"', '"person"');
  if (SALIENCE.test(path)) {
    s = s.replace('"importance":', '"salience":');
  }
  if (path.endsWith("actions.jsonl")) {
    s = s.replace('"via":', '"madeBy":');
  }
  if (CLAIMED.test(path)) {
    s = s.replace('"ref":"', '"claim":"');
  }
  return s;
};

test("records the new code writes, aged into the old names, come back the same and parse", () => {
  const stored = new Map(
    records.map(([path, , r]) => [path, `${aged(path, r)}\n`])
  );
  const renamed = renameStored(stored).files;
  for (const [path, schema, r] of records) {
    const back = JSON.parse(renamed.get(path) ?? stored.get(path) ?? "");
    expect(back).toEqual(r);
    expect(schema.safeParse(back).success).toBe(true);
  }
});

test("the agent's old word changes only where it was a stored value; words read off files keep theirs", () => {
  const renamed = renameStored(
    new Map([
      [
        "memory/verdicts.jsonl",
        `${JSON.stringify({ area: "atlas", topics: ["atlas"], unit: "u_00000000000a" })}\n`,
      ],
      [
        "memory/files.jsonl",
        `${JSON.stringify({ ref: "mail:x#1", text: "ref u_00000000000a, person:inf-x", what: "atlas" })}\n`,
      ],
    ])
  ).files;
  expect(JSON.parse(renamed.get("memory/verdicts.jsonl") ?? "")).toEqual({
    area: "atlas",
    topics: ["atlas"],
    unit: "unit_00000000000a",
  });
  expect(renamed.has("memory/files.jsonl")).toBe(false);
});

test("a board item's notes get the task's new id on their first line, a split's minted again; his words untouched", () => {
  const parent = "act_0123456789ab";
  const split = `act_${entryId(parent, "ask", "call the bank").slice(6)}`;
  const { rename } = renameStored(
    new Map([
      [
        "memory/actions.jsonl",
        jsonl(
          { id: parent, instruction: { ref: "session:x" }, kind: "ask" },
          { after: { parent, title: "call the bank" }, id: split, kind: "ask" }
        ),
      ],
    ])
  );
  expect(relabeled(`${parent}\nhey Orbit, ${parent}\nworking`, rename)).toBe(
    `entry_0123456789ab\nhey Orbit, ${parent}\nworking`
  );
  expect(relabeled(split, rename)).toBe(
    entryId("entry_0123456789ab", "ask", "call the bank")
  );
});

test("in a data dir: renamed once and recorded; lines an old process appends later join the new ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-rename-"));
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  for (const [path, text] of before) {
    write(path, text);
  }
  await migrateStored(dir);
  const ledger = () => readFileSync(join(dir, "memory/ledger.jsonl"), "utf8");
  expect(existsSync(join(dir, "memory/actions.jsonl"))).toBe(false);
  expect(ledger().trim().split("\n")).toHaveLength(3);
  expect(readFileSync(join(dir, "memory/migrations.jsonl"), "utf8")).toContain(
    "stored-names-2026-10-22"
  );
  write(
    "memory/actions.jsonl",
    jsonl({
      id: "act_00000000000d",
      kind: "add",
      madeBy: "session",
      target: "reminder:2",
    })
  );
  await migrateStored(dir);
  const lines = ledger()
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines).toHaveLength(4);
  expect(lines[3]).toEqual({
    id: "entry_00000000000d",
    kind: "add",
    target: "reminder:2",
    via: "session",
  });
  expect(existsSync(join(dir, "memory/actions.jsonl"))).toBe(false);
});

/** A data dir holding `before`, plus `extra` files. */
function dataDir(extra: [string, string][] = []) {
  const dir = mkdtempSync(join(tmpdir(), "life-rename-"));
  for (const [path, text] of [...before, ...extra]) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const read = (dir: string, path: string) =>
  readFileSync(join(dir, path), "utf8");

test("a run cut off while building is built again; memory/ was never touched", async () => {
  const dir = dataDir([["memory.renamed/units/x.jsonl", "half"]]);
  await migrateStored(dir);
  expect(existsSync(join(dir, "memory.renamed"))).toBe(false);
  expect(read(dir, "memory/ledger.jsonl").trim().split("\n")).toHaveLength(3);
  expect(existsSync(join(dir, "memory/units/x.jsonl"))).toBe(false);
});

/** The state right after the swap: the new memory in place, the old one beside it. */
function swapped() {
  const dir = dataDir();
  const out = renameStored(before);
  renameSync(join(dir, "memory"), join(dir, "memory.old"));
  for (const [path, text] of before) {
    const to = out.moves.find(([from]) => from === path)?.[1] ?? path;
    mkdirSync(join(dir, to, ".."), { recursive: true });
    writeFileSync(join(dir, to), out.files.get(path) ?? text);
  }
  writeFileSync(
    join(dir, "memory/migrations.jsonl"),
    `${JSON.stringify({ name: "stored-names-2026-10-22" })}\n`
  );
  return dir;
}
const late = jsonl({
  id: "act_00000000000e",
  instruction: { ref: obs },
  kind: "add",
  madeBy: "session",
});
const ledgerRows = (dir: string) =>
  read(dir, "memory/ledger.jsonl")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("a run cut off after the swap is settled: a late line renamed onto the new memory, once, the old copy gone", async () => {
  const dir = swapped();
  appendFileSync(join(dir, "memory.old/actions.jsonl"), late);
  // Cut off again mid-settle: the old copy is still there; settled twice, nothing is added twice.
  const copy = mkdtempSync(join(tmpdir(), "life-old-"));
  cpSync(join(dir, "memory.old"), copy, { recursive: true });
  await migrateStored(dir);
  cpSync(copy, join(dir, "memory.old"), { recursive: true });
  await migrateStored(dir);
  const lines = ledgerRows(dir);
  expect(lines).toHaveLength(4);
  expect(lines[3]).toEqual({
    id: "entry_00000000000e",
    instruction: { ref: newObs },
    kind: "add",
    via: "session",
  });
  expect(existsSync(join(dir, "memory.old"))).toBe(false);
});

test("a memory/ made between the two renames is kept and settled, never dropped", async () => {
  const dir = swapped();
  // Back to the moment between the renames: the new memory not yet in place, a stray memory/ written meanwhile.
  renameSync(join(dir, "memory"), join(dir, "memory.renamed"));
  mkdirSync(join(dir, "memory"));
  writeFileSync(join(dir, "memory/actions.jsonl"), late);
  await migrateStored(dir);
  expect(ledgerRows(dir)).toHaveLength(4);
  expect(read(dir, "memory/units/2026-10-20.jsonl")).toContain(unit);
  for (const d of ["memory.old", "memory.renamed", "memory.stray"]) {
    expect(existsSync(join(dir, d))).toBe(false);
  }
});
