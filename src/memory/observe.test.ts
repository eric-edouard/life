import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Correction,
  type InferredPerson,
  Observation,
  Person,
  type Unit,
  type Unresolved,
} from "../schema";
import { speakersByUnit, toExtract } from "./extract";
import { ledger, unit, verdict } from "./fixtures";
import { locate, parseObservations, type Source } from "./observe";
import { buildIndex } from "./search";
import { areaLookup, type Built } from "./units";
import { aboutNow, merged, resolver } from "./who";

const people = [
  Person.parse({ aliases: ["Jean"], id: "me", name: "Jean Dupont" }),
  Person.parse({
    aliases: ["Pops"],
    handles: { whatsapp: ["+66600000001"] },
    id: "dad",
    name: "Jean Senior Dupont",
  }),
  Person.parse({ aliases: ["Gas"], id: "gaston", name: "Gaston" }),
  // Owns a handle that is also someone else's alias: the handle must win.
  Person.parse({ aliases: ["+66600000001"], id: "decoy", name: "Decoy" }),
];

const source: Source = {
  lines: [
    {
      at: "2026-10-09T10:00:00.000Z",
      ref: "job-1:0@2026-10-09T10:00:00.000Z",
      speaker: "person:me",
      text: "Il faut que j’appelle le vitrier pour la fenêtre, elle fait 147 sur 44,8.",
    },
    {
      at: "2026-10-09T10:01:00.000Z",
      ref: "job-1:1@2026-10-09T10:01:00.000Z",
      speaker: "unknown:speaker_1",
      text: "Pops veut que tu repeignes la moitié   de la cuisine",
    },
    {
      at: "2026-10-09T10:02:00.000Z",
      ref: "job-1:2@2026-10-09T10:02:00.000Z",
      speaker: "unknown:speaker_1",
      text: "avec tes sœurs. Annesophie arrive demain.",
    },
  ],
  unit: unit(),
};
const texts = source.lines.map((l) => l.text);

test("the quote's line counts a message with line breaks as one line", () => {
  expect(
    locate("the second message", ["one\ntwo\nthree", "the second message"])
  ).toEqual({
    line: 1,
    verbatim: "the second message",
  });
});

test("the quote check ignores accents, case, curly quotes and spacing, and returns the source's own words", () => {
  expect(locate("il faut que j'appelle le VITRIER", texts)).toEqual({
    line: 0,
    verbatim: "Il faut que j’appelle le vitrier",
  });
  expect(
    locate("pour la fenetre, elle fait 147 sur 44,8", texts)?.verbatim
  ).toBe("pour la fenêtre, elle fait 147 sur 44,8");
  // Across two lines, and with the source's three spaces.
  expect(
    locate(
      "veut que tu repeignes la moitié de la cuisine avec tes soeurs",
      texts
    )
  ).toEqual({
    line: 1,
    verbatim: "veut que tu repeignes la moitié   de la cuisine\navec tes sœurs",
  });
  expect(
    locate("“Annesophie arrive demain.”", ["“Annesophie arrive demain.”"])
  ).toEqual({
    line: 0,
    verbatim: "“Annesophie arrive demain.”",
  });
  expect(
    locate('"Annesophie arrive demain."', ["« Annesophie arrive demain. »"])
  ).toBeNull();
});

test("the quote check rejects paraphrases, translations, elisions and quotes too short to cite", () => {
  expect(locate("Je dois appeler le vitrier", texts)).toBeNull();
  expect(locate("I have to call the glazier", texts)).toBeNull();
  expect(locate("Il faut que j’appelle … la fenêtre", texts)).toBeNull();
  expect(locate("vitrier", texts)).toBeNull();
});

test("a hinted line wins when the quote is there; otherwise the whole text is searched", () => {
  const twice = ["on se voit demain soir", "ok on se voit demain soir"];
  expect(locate("on se voit demain soir", twice, 1)?.line).toBe(1);
  expect(locate("on se voit demain soir", twice, 7)?.line).toBe(0);
});

test("names resolve cheapest first: handles, then names and aliases, else nothing", () => {
  const resolve = resolver(people);
  expect(resolve("+66600000001")).toBe("person:dad");
  expect(resolve("pops")).toBe("person:dad");
  expect(resolve("Jean (Me)")).toBe("person:me");
  expect(resolve("Annesophie")).toBeNull();
});

const inferred = (id: string, surfaces: string[], confidence = 0.8) =>
  ({
    area: "shop",
    at: "2026-10-14T00:00:00.000Z",
    confidence,
    evidence: [{ quote: "q", unit: "u_000000000001" }],
    id,
    madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
    name: "the plumber",
    project: null,
    relation: "plumber",
    schemaVersion: 1,
    surfaces,
  }) as InferredPerson;
const said = (c: Record<string, unknown>) =>
  ({ at: "2026-10-14T00:00:00.000Z", schemaVersion: 1, ...c }) as Correction;

test("a surface resolves to what the owner said, else truth, else a confident inferred person, never against a correction", () => {
  const guesses = [
    inferred("inf-plumber", ["+33611111111", "Plombier"]),
    inferred("inf-maybe", ["+33622222222"], 0.3),
  ];
  const resolve = resolver(people, guesses, [
    said({ kind: "this-is", person: "person:gaston", surface: "+33633333333" }),
    said({ kind: "not-this-person", person: "person:dad", surface: "Pops" }),
    said({
      from: "person:inf-plumber",
      kind: "same-person",
      to: "person:gaston",
    }),
  ]);
  expect(resolve("+33633333333")).toBe("person:gaston");
  expect(resolve("+66600000001")).toBe("person:dad");
  // The model's guess is used, and folded into the person the owner says it is.
  expect(resolve("plombier")).toBe("person:gaston");
  expect(resolve("+33622222222")).toBeNull();
  expect(resolve("Pops")).toBeNull();
  expect(resolver(people, guesses)("plombier")).toBe("person:inf-plumber");
  expect(
    merged([said({ from: "person:a", kind: "same-person", to: "person:a" })])(
      "person:a"
    )
  ).toBe("person:a");
});

test("an observation is about its entities, folded, plus the names that resolve now, speaker included", () => {
  const guesses = [inferred("inf-plumber", ["Plombier"])];
  const fold = said({
    from: "person:inf-plumber",
    kind: "same-person",
    to: "person:gaston",
  });
  const obs = [
    {
      entities: ["person:inf-plumber", "project:shop"],
      id: "obs_1",
      speaker: "person:me",
    },
    { entities: [], id: "obs_2", speaker: "person:me" },
    { entities: [], id: "obs_3", speaker: "unknown:Plombier" },
  ] as unknown as Observation[];
  const rows = [
    { observation: "obs_2", surface: "Plombier" },
    { surface: "Plombier" },
  ] as unknown as Unresolved[];
  expect(
    aboutNow(obs, rows, people, guesses, [fold]).map((o) => o.entities)
  ).toEqual([
    ["person:gaston", "project:shop"],
    ["person:gaston"],
    ["person:gaston"],
  ]);
  // A name that still maps to nobody marks its observation `unmapped`: it is not about Jean alone.
  const ghost = [{ observation: "obs_2", surface: "Ghost" }] as Unresolved[];
  expect(aboutNow(obs, ghost, people, [], []).map((o) => o.unmapped)).toEqual([
    false,
    true,
    false,
  ]);
});

const madeBy = {
  engine: "claude" as const,
  model: "sonnet",
  prompt: "memory-extract.v1",
  run: "r1",
};
const SHOP = "shop";
const ctx = {
  areas: areaLookup([{ id: SHOP, name: "Shop" }]),
  candidates: new Set([
    "person:me",
    "person:dad",
    "person:gaston",
    "project:bakery",
  ]),
  madeBy,
  resolve: resolver(people),
  sources: new Map([[source.unit.id, source]]),
};
const obs = (over: Record<string, unknown>) => ({
  area: SHOP,
  confidence: 0.9,
  entities: ["person:me"],
  line: 0,
  quote: "Il faut que j'appelle le vitrier",
  salience: 3,
  text: "Jean will call the glazier about the shop window.",
  type: "todo",
  unit: source.unit.id,
  when: "2026-10-12",
  ...over,
});

test("the extractor's reply is checked: quotes, units, entities; unknown names resolved or kept as unresolved", () => {
  const { observations, rejects, unresolved } = parseObservations(
    {
      observations: [
        obs({ entities: ["person:me", "project:bakery", "person:invented"] }),
        obs({
          area: "Invented area",
          confidence: 0.9,
          entities: ["unknown:Pops", "unknown:Annesophie"],
          line: 1,
          quote: "Pops veut que tu repeignes la moitié de la cuisine",
          salience: 2,
          text: "Jean's father wants him to paint half the kitchen with his sisters.",
          type: "person",
          when: null,
        }),
        obs({ quote: "Il faut réparer l'évier", text: "Fix the sink." }),
        obs({ unit: "u_invented0000" }),
        obs({ type: "nothing" }),
        obs({}),
      ],
    },
    ctx
  );
  expect(rejects.map((r) => r.reason).sort()).toEqual([
    "duplicate",
    "entity-not-candidate",
    "invalid",
    "quote-not-found",
    "unknown-unit",
  ]);
  expect(observations).toHaveLength(2);
  const [todo, family] = observations;
  expect(todo).toMatchObject({
    area: SHOP,
    entities: ["person:me", "project:bakery"],
    quote: "Il faut que j’appelle le vitrier",
    source: { channel: "lifelog", ref: "job-1:0@2026-10-09T10:00:00.000Z" },
    speaker: "person:me",
    when: "2026-10-12",
  });
  expect(family?.area).toBeNull();
  // "Pops" is resolved by code (from the model's unknown: and from the quote); a spoken claim not by Jean is capped.
  expect(family?.entities).toEqual(["person:dad"]);
  expect(family?.confidence).toBe(0.6);
  expect(unresolved).toEqual([
    {
      observation: family?.id ?? "",
      surface: "Annesophie",
      unit: source.unit.id,
    },
  ]);
  for (const o of observations) {
    expect(Observation.parse(o)).toEqual(o);
  }
  // Same unit, quote and claim: same id on every run.
  const again = parseObservations({ observations: [obs({})] }, ctx);
  expect(again.observations[0]?.id).toBe(todo?.id ?? "");
});

test("about and modality are kept when valid; a replacement stands only for a prior fact said earlier", () => {
  const prior = (id: string, at: string) =>
    [id, { at, id } as Observation] as const;
  const { observations, replaced } = parseObservations(
    {
      observations: [
        obs({
          about: "person:me",
          modality: "plan",
          replaces: [
            "obs_00000000000a",
            "obs_00000000000b",
            "obs_unknown00000",
          ],
        }),
        obs({
          about: "person:nobody",
          modality: "rumour",
          quote: "Pops veut que tu repeignes",
          text: "Dad wants Jean to paint half the kitchen.",
        }),
      ],
    },
    {
      ...ctx,
      prior: new Map([
        prior("obs_00000000000a", "2026-10-08T10:00:00.000Z"),
        prior("obs_00000000000b", "2026-10-09T11:00:00.000Z"),
      ]),
    }
  );
  const [plan, other] = observations;
  expect(plan).toMatchObject({
    about: "person:me",
    modality: "plan",
  });
  expect(replaced.map((r) => [r.old.id, r.by.id])).toEqual([
    ["obs_00000000000a", plan?.id ?? ""],
  ]);
  expect(other?.about).toBeUndefined();
  expect(other?.modality).toBeUndefined();
  for (const o of observations) {
    expect(Observation.parse(o)).toEqual(o);
  }
});

test("the observation schema refuses records a later reader could not trust", () => {
  const [good] = parseObservations(
    { observations: [obs({})] },
    ctx
  ).observations;
  expect(Observation.safeParse(good).success).toBe(true);
  for (const bad of [
    { ...good, id: "obs_nothex" },
    { ...good, salience: 0 },
    { ...good, type: "nothing" },
    { ...good, area: "Shop" },
    { ...good, entities: ["dad"] },
    { ...good, extra: 1 },
  ]) {
    expect(Observation.safeParse(bad).success).toBe(false);
  }
});

const built = (u: Unit): Built => ({ messages: [], text: "", unit: u });
test("the cache: a unit is read again only when its content or the prompt changed", () => {
  const a = unit({ id: "u_00000000000a" });
  const b = unit({ id: "u_00000000000b" });
  const c = unit({ id: "u_00000000000c" });
  const d = unit({ hash: "ffffffffffffffff", id: "u_00000000000d" });
  const e = unit({ id: "u_00000000000e" });
  const verdicts = ledger([
    verdict(a, { salience: 2 }),
    verdict(b, { salience: 0 }),
    verdict(c, { salience: 3 }),
    // Judged on older content.
    verdict(d, { hash: "0123456789abcdef", salience: 3 }),
    // Salience 1: searchable, never read in full.
    verdict(e, { salience: 1 }),
  ]);
  const extracted = [
    {
      at: "2026-10-10T02:00:00.000Z",
      observations: 2,
      prompt: "memory-extract.v1",
      run: "r0",
      schemaVersion: 1 as const,
      unit: c.id,
      unitHash: c.hash,
    },
  ];
  const r = toExtract(
    [a, b, c, d, e].map(built),
    verdicts,
    extracted,
    "memory-extract.v1"
  );
  expect(r.kept.map((k) => k.b.unit.id)).toEqual([a.id, c.id]);
  expect(r.pending.map((k) => k.b.unit.id)).toEqual([a.id]);
  expect(r.stale).toBe(1);
  expect(
    toExtract([c].map(built), verdicts, extracted, "memory-extract.v2").pending
  ).toHaveLength(1);
});

test("identity is part of the cache: a unit whose people resolve to someone else since is read again, once", () => {
  const sam = unit({ id: "u_00000000001a", people: ["person:lou"] });
  const verdicts = ledger([verdict(sam, { salience: 3 })]);
  const readLine = (readAs?: string[]) => ({
    at: "2026-10-10T02:00:00.000Z",
    observations: 1,
    ...(readAs ? { people: readAs } : {}),
    prompt: "memory-extract.v1",
    run: "r0",
    schemaVersion: 1 as const,
    unit: sam.id,
    unitHash: sam.hash,
  });
  const pending = (
    ledgerLines: ReturnType<typeof readLine>[],
    spoke = new Map<string, string[]>()
  ) =>
    toExtract([built(sam)], verdicts, ledgerLines, "memory-extract.v1", spoke)
      .pending.length;
  // Read as someone else, now Lou: read again.
  expect(pending([readLine(["person:sam"])])).toBe(1);
  // Read as Lou already: cached, so it is read once.
  expect(pending([readLine(["person:sam"]), readLine(["person:lou"])])).toBe(0);
  // A line from before `people` was recorded: its observations' speakers decide.
  expect(pending([readLine()], new Map([[sam.id, ["person:sam"]]]))).toBe(1);
  expect(pending([readLine()], new Map([[sam.id, ["person:lou"]]]))).toBe(0);
  expect(pending([readLine()])).toBe(0);
});

test("who said a unit's observations: the owner aside, folds applied", () => {
  const spokenBy = (unitId: string, by: string) =>
    ({ speaker: by, unit: unitId }) as Parameters<
      typeof speakersByUnit
    >[0][number];
  const bySpeaker = speakersByUnit(
    [
      spokenBy("u_1", "person:me"),
      spokenBy("u_1", "person:inf-sam"),
      spokenBy("u_1", "unknown:+1555"),
      spokenBy("u_2", "person:lou"),
    ],
    (r) => (r === "person:inf-sam" ? "person:sam" : r)
  );
  expect(bySpeaker.get("u_1")).toEqual(["person:sam"]);
  expect(bySpeaker.get("u_2")).toEqual(["person:lou"]);
});

test("the index is rebuilt from observations: search ignores accents, links answer by entity", async () => {
  const { observations } = parseObservations(
    {
      observations: [
        obs({}),
        obs({
          entities: ["person:dad"],
          line: 1,
          quote: "Pops veut que tu repeignes la moitié de la cuisine",
          text: "Jean's father wants him to paint half the kitchen.",
        }),
      ],
    },
    ctx
  );
  const path = join(
    await mkdtemp(join(tmpdir(), "life-index-")),
    "index.sqlite"
  );
  const first = unit({
    people: ["person:dad"],
    summary: "Débat sur l'invention de la programmation",
  });
  const indexed = [
    {
      unit: first,
      verdict: verdict(first, {
        topics: ["philosophy", "ai"],
        type: "person",
      }),
    },
    { unit: unit({ id: "u_000000000002", title: "Counter talk" }) },
  ];
  expect(
    buildIndex(
      [...observations, ...observations],
      path,
      {
        corrections: [],
        latest: new Map(),
        live: new Set(["u_000000000001", "u_000000000002"]),
        retired: new Map(),
      },
      indexed
    )
  ).toBe(2);
  const db = new Database(path, { readonly: true });
  // Units: found by a summary word and by topic; a tag can be narrowed to the units a person is in.
  expect(
    db
      .query<{ id: string }, [string]>(
        "select id from unit_search where unit_search match ?"
      )
      .all("programmation OR philosophy")
  ).toEqual([{ id: "u_000000000001" }]);
  expect(
    db
      .query<{ n: number }, [string]>(
        `select count(*) as n from unit_topics t join unit_people p on p.unit = t.unit where t.topic = ? and p.person = 'person:dad'`
      )
      .get("ai")?.n
  ).toBe(1);
  const hits = db
    .query<{ id: string }, [string]>(
      "select id from search where search match ?"
    )
    .all("fenetre OR moitie");
  expect(hits).toHaveLength(1);
  expect(
    db
      .query<{ n: number }, [string]>(
        "select count(*) as n from links where entity = ?"
      )
      .get("person:dad")?.n
  ).toBe(1);
  db.close();
});
