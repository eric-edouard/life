import { expect, test } from "bun:test";
import type { InferredPerson } from "../records/observation";
import { answeredBy, checkPeople, inferredId, unknownIn } from "./people";
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

test("an answer is kept only for a surface we asked about, with a quote in the text of a unit it appears in", () => {
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
    projects: new Set(["bakery"]),
    taken: new Set(["inf_plumber"]),
    truth: new Set(["person:claire"]),
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
  expect([r?.area, r?.project, r?.surfaces]).toEqual([
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
  // A link only to someone in truth/, never to another guess.
  const linked = (person: string) =>
    checkPeople([say({ person })], ctx)[0]?.person;
  expect(linked("person:claire")).toBe("person:claire");
  expect(linked("person:inf_plumber")).toBeNull();
  expect(inferredId("", "k", new Set())).toBe("inf_person");
});

test("a surface is asked about until it reads as someone in truth/ or as a guess judged against the directory", () => {
  const guess = (surface: string, person?: string | null) =>
    ({ person, surfaces: [surface] }) as InferredPerson;
  const reads: Record<string, string> = {
    Bob: "person:inf_bob",
    Claire: "person:claire",
    Dan: "person:inf_dan",
    Eve: "person:inf_eve",
  };
  const answered = answeredBy(
    (s) => reads[s] ?? null,
    [guess("Bob"), guess("Dan", null), guess("Eve", "person:claire")]
  );
  expect(["Claire", "Bob", "Dan", "Eve", "Zed"].map(answered)).toEqual([
    true,
    false,
    true,
    true,
    false,
  ]);
});
