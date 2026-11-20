import { expect, test } from "bun:test";
import type { InferredPerson } from "../records/observation";
import {
  answeredBy,
  checkPeople,
  earlierGuessOf,
  inferredId,
  oldGuessesIn,
  unknownIn,
} from "./people";
import type { Built } from "./units";

const SUFFIXED = /^inf_plumber-[0-9a-f]{6}$/;

const chat = (unit: string, sender: string, texts: string[]) =>
  ({
    messages: texts.map((text, i) => ({
      at: `2026-10-01T0${i}:00:00.000Z`,
      fromMe: i === 0,
      id: `${unit}-${i}`,
      sender: i === 0 ? "me" : sender,
      text,
    })),
    text: `Shop plumbing\n${texts.map((t, i) => `0${i}:00 ${i === 0 ? "me" : sender}: ${t}`).join("\n")}`,
    unit: {
      id: unit,
      people: [`unknown:${sender}`, "unknown:Cédric", "unknown:speaker_2"],
      source: "whatsapp",
    },
  }) as unknown as Built;

test("a day's unknown people: chat senders no handle maps and names lifelog gave, never a known one, a mail sender or a numbered voice", () => {
  const a = chat("unit_1", "+33600000001", ["Ok ?", "Je passe demain"]);
  const b = chat("unit_2", "+33600000002", ["Merci", "De rien"]);
  const mail = {
    ...chat("unit_3", "billing@shop.example", ["Hi", "Invoice"]),
    unit: {
      id: "unit_3",
      people: ["unknown:billing@shop.example"],
      source: "mail",
    },
  } as unknown as Built;
  const unknown = unknownIn([a, b, mail], (s) => s === "+33600000002");
  expect(
    [...unknown].map(([k, seen]) => [k, seen.map((x) => x.unit.id)])
  ).toEqual([
    ["+33600000001", ["unit_1"]],
    ["Cédric", ["unit_1", "unit_2"]],
  ]);
});

test("an answer is kept only for a name or handle we asked about, with a quote in the text of a unit it appears in", () => {
  const seen = chat("unit_1", "+33600000001", [
    "Ok ?",
    "Je passe demain pour l'évier de la boutique",
  ]);
  const ctx = {
    areas: new Map([["shop", "shop"]]),
    at: "2026-10-14T00:00:00.000Z",
    madeBy: {
      engine: "codex" as const,
      model: "m",
      prompt: "memory-episodes.v3",
      run: "r",
    },
    people: new Set(["person:claire", "person:inf_earlier"]),
    projects: new Set(["bakery"]),
    resolve: (s: string) =>
      s === "+33600000001" ? "person:inf_earlier" : null,
    taken: new Set(["inf_plumber"]),
    units: [seen],
    unknown: new Map([["+33600000001", [seen]]]),
  };
  const say = (over: Record<string, unknown>) => ({
    area: "Shop",
    confidence: 0.7,
    evidence: [{ quote: "je passe demain pour l'évier", unit: "unit_1" }],
    key: "+33600000001",
    name: "Plumber",
    project: "nope",
    relation: "plumber changing the shop sink",
    ...over,
  });
  const [r, ...rest] = checkPeople(
    [
      say({}),
      say({ name: "Again" }),
      say({ key: "+33699999999" }),
      say({ evidence: [{ quote: "something never said", unit: "unit_1" }] }),
    ],
    ctx
  );
  expect(rest).toEqual([]);
  expect(r?.evidence).toEqual([
    { quote: "Je passe demain pour l'évier", unit: "unit_1" },
  ]);
  expect([r?.area, r?.project, r?.namesAndHandles]).toEqual([
    "shop",
    null,
    ["+33600000001"],
  ]);
  // "inf_plumber" was taken: the id gets a suffix, and never starts like a truth id.
  expect(r?.id).toMatch(SUFFIXED);
  expect(
    checkPeople(
      [say({ evidence: [{ quote: "je passe demain", unit: "unit_9" }] })],
      ctx
    )
  ).toEqual([]);
  // A link to anyone the call was shown, but not off the map and not the key's own earlier guess.
  const linked = (person: string) =>
    checkPeople([say({ person })], ctx)[0]?.person;
  expect(linked("person:claire")).toBe("person:claire");
  expect(linked("person:inf_plumber")).toBeNull();
  expect(linked("person:inf_earlier")).toBeNull();
  expect(
    checkPeople([say({ key: "Cédric", person: "person:inf_earlier" })], {
      ...ctx,
      unknown: new Map([["Cédric", [seen]]]),
    })[0]?.person
  ).toBe("person:inf_earlier");
  // `isOrganization` is always written.
  expect(checkPeople([say({})], ctx)[0]?.isOrganization).toBe(false);
  expect(
    checkPeople([say({ isOrganization: true })], ctx)[0]?.isOrganization
  ).toBe(true);
  expect(inferredId("", "k", new Set())).toBe("inf_person");
});

test("one record per person: the other written forms join its namesAndHandles, and a later entry for one is dropped", () => {
  const seen = chat("unit_1", "+33600000001", ["Ok ?", "Je passe demain"]);
  const ctx = {
    areas: new Map<string, string>(),
    at: "2026-10-14T00:00:00.000Z",
    madeBy: {
      engine: "codex" as const,
      model: "m",
      prompt: "memory-episodes.v9",
      run: "r",
    },
    people: new Set<string>(),
    projects: new Set<string>(),
    resolve: () => null,
    taken: new Set<string>(),
    units: [seen],
    unknown: new Map([
      ["+33600000001", [seen]],
      ["Cédric", [seen]],
    ]),
  };
  const say = (over: Record<string, unknown>) => ({
    confidence: 0.7,
    evidence: [{ quote: "Je passe demain", unit: "unit_1" }],
    key: "Cédric",
    name: "Cédric",
    relation: "plumber",
    ...over,
  });
  const records = checkPeople(
    [
      say({ otherForms: ["+33600000001", "Cédric"] }),
      say({ key: "+33600000001" }),
    ],
    ctx
  );
  expect(records.map((r) => r.namesAndHandles)).toEqual([
    ["Cédric", "+33600000001"],
  ]);
});

test("a name the call volunteers is kept only with a quote in the day's units that holds it, and only when linked or settled", () => {
  const seen = chat("unit_1", "+33600000001", [
    "Ok ?",
    "Dr Ploum du cabinet vous attend",
  ]);
  const ctx = {
    areas: new Map<string, string>(),
    at: "2026-10-14T00:00:00.000Z",
    madeBy: {
      engine: "codex" as const,
      model: "m",
      prompt: "memory-episodes.v9",
      run: "r",
    },
    people: new Set(["person:claire"]),
    projects: new Set<string>(),
    resolve: () => null,
    taken: new Set<string>(),
    units: [seen],
    unknown: new Map<string, Built[]>(),
  };
  const say = (over: Record<string, unknown>) => ({
    confidence: 0.5,
    evidence: [{ quote: "Dr Ploum du cabinet", unit: "unit_1" }],
    key: "Ploum",
    name: "Dr Ploum",
    relation: "doctor",
    ...over,
  });
  const kept = (over: Record<string, unknown>) =>
    checkPeople([say(over)], ctx).length;
  // Unsure and unlinked: not kept.
  expect(kept({})).toBe(0);
  expect(kept({ person: "person:claire" })).toBe(1);
  expect(kept({ isOrganization: true })).toBe(1);
  expect(kept({ confidence: 0.9 })).toBe(1);
  // The quote must hold the name, and be in a unit of the day.
  expect(
    kept({ confidence: 0.9, evidence: [{ quote: "Ok ?", unit: "unit_1" }] })
  ).toBe(0);
  expect(
    kept({
      confidence: 0.9,
      evidence: [{ quote: "Dr Ploum du cabinet", unit: "unit_9" }],
    })
  ).toBe(0);
});

test("a name or handle is asked about until it reads as someone in truth/ or as a guess judged against the directory", () => {
  const guess = (nameOrHandle: string, isOrganization?: boolean) =>
    ({ isOrganization, namesAndHandles: [nameOrHandle] }) as InferredPerson;
  const reads: Record<string, string> = {
    Bob: "person:inf_bob",
    Claire: "person:claire",
    Dan: "person:inf_dan",
    Eve: "person:inf_eve",
  };
  const answered = answeredBy(
    (s) => reads[s] ?? null,
    [guess("Bob"), guess("Dan", false), guess("Eve", true)]
  );
  // A Beeper ghost id judged is judged for Life's own bridge's form too.
  expect(
    answeredBy(
      () => "person:inf_kit",
      [guess("@line__u91_abc:beeper.local", false)]
    )("_u91_abc")
  ).toBe(true);
  expect(["Claire", "Bob", "Dan", "Eve", "Zed"].map(answered)).toEqual([
    true,
    false,
    true,
    true,
    false,
  ]);
});

test("an older guess whose evidence is in the day's units is asked again with them, until a v9 call judges its name", () => {
  const seen = chat("unit_1", "+33600000001", ["Ok ?", "Miss Dana pays"]);
  const other = chat("unit_2", "+33600000002", ["Hi"]);
  const old = (
    id: string,
    key: string,
    unit: string,
    isOrganization?: boolean
  ) =>
    ({
      evidence: [{ quote: "q", unit }],
      id,
      isOrganization,
      namesAndHandles: [key],
    }) as InferredPerson;
  const asked = (inferred: InferredPerson[]) =>
    [...oldGuessesIn([seen, other], inferred)].map(([k, b]) => [
      k,
      b.map((x) => x.unit.id),
    ]);
  expect(asked([old("inf_a", "Miss Dana", "unit_1")])).toEqual([
    ["Miss Dana", ["unit_1"]],
  ]);
  // Judged since (by this key), or evidence on another day: not asked.
  expect(
    asked([
      old("inf_a", "Miss Dana", "unit_1"),
      old("inf_b", "Miss Dana", "unit_1", false),
    ])
  ).toEqual([]);
  expect(asked([old("inf_c", "Eve", "unit_9")])).toEqual([]);
});

test("the earlier guess a key reads as is shown to the call; truth/ and nothing are not", () => {
  expect(earlierGuessOf("person:inf_kit")).toBe("person:inf_kit");
  expect(earlierGuessOf("person:claire")).toBeUndefined();
  expect(earlierGuessOf(null)).toBeUndefined();
});
