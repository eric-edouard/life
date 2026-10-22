import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { momentId } from "../memory/moments";
import { observationId } from "../memory/observe";
import { lineHash } from "../memory/page-format";
import { unitId } from "../memory/units";
import { renameSettings, renameStored } from "./migrate";

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

const jsonl = (...records: object[]) =>
  `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
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

test("the settings' old names are renamed in place, once", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-settings-")), "s.json");
  writeFileSync(
    path,
    JSON.stringify({
      actions: { backend: "reminders" },
      sources: ["lifelog", "atlas"],
    })
  );
  renameSettings(path);
  const once = readFileSync(path, "utf8");
  expect(JSON.parse(once)).toEqual({
    sources: ["lifelog", "agent"],
    todo_list: { backend: "reminders" },
  });
  renameSettings(path);
  expect(readFileSync(path, "utf8")).toBe(once);
});
