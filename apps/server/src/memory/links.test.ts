import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import { type LinkBatch, LinkBatch as LinkBatchSchema } from "../records/link";
import type { Observation } from "../records/observation";
import { endingsOf } from "./endings";
import {
  isLater,
  isOutOfReach,
  keptLinks,
  laterRecordsOf,
  nightOf,
  splitSteps,
  subjectWorkOf,
} from "./links";
import { type MatterStepNow, matterBookOf } from "./matter-read";

const matter = { id: "matter_0000000000a1", name: "The contract with Ann" };
const step = (n: number, at: string, quote: string, type = "promise") => ({
  at,
  day: at.slice(0, 10),
  id: `obs_${String(n).padStart(12, "0")}`,
  quote,
  said_by: "me",
  text: quote,
  type,
});
const promise = step(
  1,
  "2026-10-01T10:00:00.000Z",
  "I'll send you the contract"
);
const sent = step(
  2,
  "2026-10-03T09:00:00.000Z",
  "Contract sent this morning, check your mail",
  "idea"
);
const unrelated = step(
  3,
  "2026-10-04T09:00:00.000Z",
  "See you at the gym on Friday",
  "idea"
);
// The day's call, an episode as `matterOf` makes it a step of the matter (same shape as any other).
const callStep = matterBookOf(
  {
    matters: [
      {
        areas: [],
        id: matter.id,
        name: matter.name,
        projects: [],
        steps: [{ ref: "unit_000000000009" }, { ref: promise.id }],
      },
    ],
    offered: new Set(),
  },
  {
    current: new Set(),
    directions: [],
    episodeOf: new Map([
      [
        "unit_000000000009",
        {
          day: "2026-10-02",
          id: "ep_0123456789ab",
          people: [],
          start: "2026-10-02",
          title: "Call with Ann",
          what: "Ann confirmed the contract arrived and is signed",
        } as unknown as Episode,
      ],
    ]),
    isMailer: () => false,
    ledger: [],
    linkEndings: new Map(),
    observations: [
      {
        at: promise.at,
        date: promise.day,
        id: promise.id,
        importance: 3,
        quote: promise.quote,
        speaker: "person:me",
        subjects: [],
        text: promise.text,
        type: "promise",
        unit: "unit_000000000001",
      } as unknown as Observation,
    ],
    refOf: (r) => r,
    retired: new Map(),
    todoItems: [],
  },
  "2026-10-10"
)[0]?.steps.find((x) => x.kind === "episode");
const call = {
  at: callStep?.at ?? "",
  day: callStep?.day ?? "",
  id: callStep?.ref ?? "",
  quote: callStep?.quote ?? "",
  text: callStep?.text ?? "",
  type: "episode",
};
/** The links prompt the code uses now: a bump changes it here too. */
const PROMPT_NOW = "memory-links.v4";
const batch = (
  open: { id: string }[],
  offered: { id: string }[],
  links: LinkBatch["links"] = [],
  prompt = PROMPT_NOW
): LinkBatch => ({
  at: "2026-10-05T22:00:00.000Z",
  links,
  madeBy: { engine: "claude", model: "m", prompt, run: "r" },
  offered: offered.map((o) => o.id),
  open: open.map((o) => o.id),
  schemaVersion: 1,
  subject: matter.id,
});

test("a link is kept only when both ends were shown, the later one is later, and its words are found in its own quote", () => {
  const shown = { later: [sent, unrelated], open: [promise] };
  const link = (earlier: string, later: string, quote: string) => ({
    earlier,
    later,
    quote,
  });
  expect(
    keptLinks(
      {
        links: [
          link(promise.id, sent.id, "contract sent this morning"),
          // Words the later observation never held.
          link(promise.id, unrelated.id, "he sent the contract"),
          // An end that was not shown.
          link("obs_00000000dead", sent.id, "Contract sent this morning"),
          // The wrong way round: nothing ends before it was said.
          link(sent.id, promise.id, "I'll send you the contract"),
        ],
      },
      shown
    )
  ).toEqual([
    {
      earlier: promise.id,
      later: sent.id,
      quote: "Contract sent this morning",
      relation: "ends",
    },
  ]);
  expect(
    keptLinks(
      { links: [link(promise.id, sent.id, "Contract sent this morning")] },
      { later: [{ ...sent, at: promise.at }], open: [promise] }
    )
  ).toEqual([]);
  expect(keptLinks({}, shown)).toEqual([]);
});

test("a pair is judged once: a later observation is due until a batch holds it with that open thing", () => {
  const work = subjectWorkOf(matter, [promise], [unrelated, sent], []);
  // Oldest first; an observation from before the open thing is never due for it.
  expect(work?.chunks).toEqual([[sent, unrelated]]);
  expect(work?.open).toEqual([promise]);
  expect(
    subjectWorkOf(
      matter,
      [promise],
      [
        sent,
        { ...sent, at: "2026-09-01T00:00:00.000Z", id: "obs_000000000009" },
      ],
      [batch([promise], [sent])]
    )
  ).toBeNull();
  // A promise made after that batch was never judged against the same later observations.
  const second = step(4, "2026-10-02T10:00:00.000Z", "and the invoice too");
  const again = subjectWorkOf(
    matter,
    [promise, second],
    [sent, unrelated],
    [batch([promise], [sent, unrelated])]
  );
  expect(again?.open).toEqual([second]);
  expect(again?.chunks).toEqual([[sent, unrelated]]);
});

test("what ends a thing is its first link whose two ends are both current", () => {
  const first = {
    earlier: promise.id,
    later: unrelated.id,
    quote: "x",
    relation: "ends" as const,
  };
  const then = {
    earlier: promise.id,
    later: sent.id,
    quote: "y",
    relation: "ends" as const,
  };
  const batches = [
    batch([promise], [unrelated], [first]),
    batch([promise], [sent], [then]),
  ];
  expect(endingsOf(batches, () => true).get(promise.id)?.later).toBe(
    unrelated.id
  );
  // Its later end was re-read away: the link counts for nothing, the next one stands.
  expect(
    endingsOf(batches, (id) => id !== unrelated.id).get(promise.id)?.later
  ).toBe(sent.id);
  // The open thing itself re-read away: no ending under its old id.
  expect(endingsOf(batches, (id) => id !== promise.id).size).toBe(0);
});

test("a night takes the oldest due work first and caps each person, so a long backlog neither starves nor is starved", () => {
  const chunk = (at: string) => [step(7, at, "q")];
  const big = {
    chunks: Array.from({ length: 30 }, () => chunk("2026-01-01T00:00:00.000Z")),
    name: "Big",
    open: [promise],
    subject: "matter_0000000000b1",
  };
  const small = {
    chunks: [chunk("2026-10-01T00:00:00.000Z")],
    name: matter.name,
    open: [promise],
    subject: matter.id,
  };
  const night = nightOf([small, big]);
  expect(night.map((w) => [w.subject, w.chunks.length])).toEqual([
    ["matter_0000000000b1", 10],
    [matter.id, 1],
  ]);
  // A matter whose open steps need more calls a chunk than its share still gets one chunk a night.
  const many = {
    chunks: [
      chunk("2026-01-01T00:00:00.000Z"),
      chunk("2026-01-02T00:00:00.000Z"),
    ],
    name: "Many",
    open: Array.from({ length: 450 }, () => promise),
    subject: "matter_0000000000b2",
  };
  expect(nightOf([many]).map((w) => w.chunks.length)).toEqual([1]);
});

test("the call's episode ends the promise, a record never shown is never linked, and a step that repeats the promise ends nothing", () => {
  const link = (earlier: string, later: string, quote: string) => ({
    earlier,
    later,
    quote,
  });
  // An episode is a later step like any other; its id is kept as the link's later end.
  expect(
    keptLinks(
      { links: [link(promise.id, call.id, "contract arrived and is signed")] },
      { later: [call, unrelated], open: [promise] }
    )
  ).toEqual([
    {
      earlier: promise.id,
      later: call.id,
      quote: "contract arrived and is signed",
      relation: "ends",
    },
  ]);
  // A step of another matter was never shown in this call: no link can tie to it.
  expect(
    keptLinks(
      { links: [link(promise.id, "obs_00000000beef", "Contract sent")] },
      { later: [sent], open: [promise] }
    )
  ).toEqual([]);
  // The repeat of the promise is another open step, so it is never offered as an ending.
  const at = (ref: string, kind: MatterStepNow["kind"], day: string) =>
    ({
      at: `${day}T10:00:00.000Z`,
      day,
      ended: false,
      kind,
      quote: "q",
      ref,
      text: "t",
    }) as MatterStepNow;
  const steps = [
    at(promise.id, "promise", "2026-10-01"),
    at("obs_000000000005", "promise", "2026-10-02"),
    at(call.id, "episode", "2026-10-02"),
    at(sent.id, "idea", "2026-10-03"),
  ];
  const byId = new Map(
    [promise.id, "obs_000000000005", sent.id].map((id) => [
      id,
      { modality: undefined },
    ])
  );
  const split = splitSteps(steps, byId);
  expect(split.open.map((s) => s.ref)).toEqual([
    promise.id,
    "obs_000000000005",
  ]);
  expect(split.later.map((s) => s.ref)).toEqual([call.id, sent.id]);
});

test("a batch that offered an episode is a valid line", () => {
  expect(() => LinkBatchSchema.parse(batch([promise], [call]))).not.toThrow();
});

test("an episode ends a step from its day on; any other record only once said after it", () => {
  const sameDayCall = { ...promise, id: "ep_0000000000c1", type: "episode" };
  expect(isLater(promise, sameDayCall)).toBe(true);
  expect(
    isLater(promise, { ...promise, id: "obs_000000000009", type: "idea" })
  ).toBe(false);
  expect(isLater(promise, sent)).toBe(true);
});

test("a matter's later records: its people's unplaced notes since its oldest open step, however late, never one another matter holds (case links-2-late-answer)", () => {
  const open = [
    {
      at: "2026-09-02T10:00:00.000Z",
      day: "2026-09-02",
      kind: "waiting_on_someone",
      quote: "q",
      ref: "obs_router",
      text: "t",
    },
  ] as MatterStepNow[];
  const note = (id: string, date: string, more: Partial<Observation> = {}) =>
    ({
      at: `${date}T10:00:00.000Z`,
      date,
      id,
      speaker: "person:sam",
      subjects: [],
      type: "event",
      ...more,
    }) as Observation;
  const notes = [
    note("obs_boxes", "2026-09-05", {
      speaker: "unknown:shop",
      subjects: ["person:sam-old"],
    }),
    note("obs_rent_nov", "2026-09-06"),
    note("obs_late", "2026-11-13"),
    note("obs_before", "2026-09-01"),
    note("obs_other", "2026-09-04", { speaker: "person:lea" }),
    note("obs_again", "2026-09-04", { type: "promise" }),
    note("obs_plan", "2026-09-04", { modality: "plan" }),
  ];
  const kept = laterRecordsOf(
    open,
    new Set(["person:sam"]),
    notes,
    (id) => id === "obs_rent_nov",
    (ref) => (ref === "person:sam-old" ? "person:sam" : ref)
  );
  // Read through refOf; the November rent is another matter's; an answer two months on still counts (a wait is
  // answered when it is); before the step, another person, a promise again and a plan are no endings.
  expect(kept.map((o) => o.id)).toEqual(["obs_boxes", "obs_late"]);
});

test("a pair is judged once per prompt: a new prompt asks a still-open step again (case links-1-made-unneeded)", () => {
  const judgedBefore = batch([promise], [sent], [], "memory-links.v3");
  expect(
    subjectWorkOf(matter, [promise], [sent], [judgedBefore])?.chunks
  ).toEqual([[sent]]);
  expect(
    subjectWorkOf(matter, [promise], [sent], [batch([promise], [sent])])
  ).toBeNull();
});

// His report of 19 Nov 2026: a court case stayed "stuck" on "find a lawyer" weeks after the lawyer came on site. It
// was full (40 steps), so the matters step put the meeting in other matters, and the links step never shows a matter
// another matter's records: nothing could end its open steps. A full matter reads its people's records wherever held.
test("another matter's record is out of a matter's reach, unless that matter is full and its story goes on elsewhere", () => {
  const held = new Set(["obs_meeting"]);
  const stepsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ref: `obs_${i}` }));
  const matterOf = (steps: number, areas = ["home"]) => ({
    areas,
    steps: stepsOf(steps) as MatterStepNow[],
  });
  expect(isOutOfReach(matterOf(12), held, "obs_meeting")).toBe(true);
  expect(isOutOfReach(matterOf(12), held, "obs_unplaced")).toBe(false);
  expect(isOutOfReach(matterOf(40), held, "obs_meeting")).toBe(false);
  // Its own steps stay out: they are already its later steps.
  expect(isOutOfReach(matterOf(40), new Set(["obs_0"]), "obs_0")).toBe(true);
  expect(
    isOutOfReach(matterOf(3, ["a", "b", "c", "d"]), held, "obs_meeting")
  ).toBe(false);
});
