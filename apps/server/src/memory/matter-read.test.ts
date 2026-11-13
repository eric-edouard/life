import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import type { Observation } from "../records/observation";
import { type MatterRecords, matterBookOf } from "./matter-read";
import { openItems } from "./open-items";
import { dayLines } from "./read-day";
import { matterItems, openWithOf } from "./read-open-items";
import { OWNER } from "./read-truth";

const pad = (n: number) => String(n).padStart(12, "0");
const [GRAN, PARTNER, SHOP] = ["person:gran", "person:partner", "person:shop"];
const NAMES: Record<string, string> = {
  [GRAN]: "Gran",
  [PARTNER]: "Partner",
  [SHOP]: "Shopkeeper",
};
const nameOf = (r: string) => NAMES[r] ?? r;

const obs = (n: number, day: string, over: Partial<Observation>) =>
  ({
    area: null,
    at: `${day}T10:00:00.000Z`,
    date: day,
    id: `obs_${pad(n)}`,
    importance: 3,
    quote: "q",
    speaker: OWNER,
    subjects: [OWNER],
    text: "t",
    type: "to_do",
    unit: `unit_${pad(n)}`,
    when: null,
    ...over,
  }) as Observation;
const episode = (
  n: number,
  day: string,
  title: string,
  people: [string, "with" | "told"][]
) =>
  ({
    copies: [],
    day,
    id: `ep_${pad(n)}`,
    people: people.map(([ref, role]) => ({ ref, role })),
    start: day,
    title,
    units: [`unit_${pad(n)}`],
    what: `${title}.`,
  }) as unknown as Episode;

const episodes = [
  episode(1, "2026-10-02", "Gran's watch", [[GRAN, "with"]]),
  episode(2, "2026-10-03", "Chat with partner", [[PARTNER, "with"]]),
  episode(4, "2026-10-12", "A promise", [[GRAN, "with"]]),
  episode(5, "2026-10-16", "Call to the shop", [
    [PARTNER, "with"],
    [SHOP, "told"],
  ]),
];
const observations = [
  // Gran asks him, in person.
  obs(1, "2026-10-02", {
    quote: "can you get my watch mended",
    speaker: GRAN,
    subjects: [OWNER, GRAN],
    text: "Get Gran's watch repaired",
  }),
  // A small fact of a unit the matter holds: rated 1, not placed, so not a step.
  obs(11, "2026-10-02", {
    importance: 1,
    text: "Gran says the strap broke",
    type: "choice",
    unit: `unit_${pad(1)}`,
  }),
  // The partner's suggestion, rated 2: a step with its episode.
  obs(2, "2026-10-03", {
    importance: 2,
    speaker: PARTNER,
    subjects: [OWNER, PARTNER],
    text: "Try the shop on Elm Street",
    type: "choice",
  }),
  // His promise, rated 1 but placed.
  obs(5, "2026-10-12", {
    area: "family",
    importance: 1,
    quote: "I'll call the shop",
    subjects: [OWNER, GRAN, "project:shop-fit-out"],
    text: "Call the shop",
    type: "promise",
  }),
];
const line = {
  areas: [],
  id: "matter_aaaaaaaaaaaa",
  name: "Mend Gran's watch",
  projects: [],
  steps: [
    { ref: `unit_${pad(1)}` },
    { ref: `unit_${pad(2)}` },
    { ref: `unit_${pad(4)}` },
    { ref: obs(5, "", {}).id },
    { ref: `unit_${pad(5)}` },
  ],
};
const records = (over: Partial<MatterRecords> = {}): MatterRecords => ({
  endings: new Set(),
  episodeOf: new Map(episodes.flatMap((m) => m.units.map((u) => [u, m]))),
  ledger: [],
  observations,
  refOf: (r) => r,
  todoItems: [],
  ...over,
});
const book = (over: Partial<MatterRecords> = {}, today = "2026-10-20") =>
  matterBookOf([line], records(over), today);

test("the errand: moving, next 'call the shop', owed to Gran, the partner only with", () => {
  const [errand, ...rest] = book();
  expect(rest).toEqual([]);
  expect(errand).toMatchObject({
    areas: ["family"],
    next: { kind: "promise", text: "Call the shop" },
    open: true,
    owedTo: [GRAN],
    projects: ["shop-fit-out"],
    status: "moving",
    told: [SHOP],
    waitingOn: [],
  });
  expect(errand?.with).toEqual([GRAN, PARTNER]);
  expect(errand?.owedTo).not.toContain(PARTNER);
  // Time order; the small fact stays out, the rated-2 one and the placed rated-1 one are in.
  expect(errand?.steps.map((s) => s.text)).toEqual([
    "Gran's watch",
    "Get Gran's watch repaired",
    "Chat with partner",
    "Try the shop on Elm Street",
    "A promise",
    "Call the shop",
    "Call to the shop",
  ]);
});

test("a matter's status: done when its newest open step is ended, stuck when a date passed, waiting, dormant", () => {
  const promise = obs(5, "", {}).id;
  expect(book({ endings: new Set([promise]) })[0]?.status).toBe("done");
  // The older to-do ended does not close a matter whose newest to-do or promise is open.
  expect(book({ endings: new Set([obs(1, "", {}).id]) })[0]?.open).toBe(true);
  // Silence is never stuck: no step for a while is dormant, still open.
  expect(book({}, "2026-11-20")[0]?.status).toBe("dormant");
  expect(book({}, "2026-12-30")[0]).toMatchObject({
    open: true,
    status: "dormant",
  });
  const due = observations.map((o) =>
    o.type === "promise" ? { ...o, when: "2026-10-18" } : o
  );
  expect(book({ observations: due })[0]?.status).toBe("stuck");
  // A passed date is stuck at any age.
  expect(book({ observations: due }, "2026-12-30")[0]?.status).toBe("stuck");
  const waits = [
    ...observations,
    obs(6, "2026-10-17", {
      subjects: [OWNER, SHOP],
      text: "The shop answers",
      type: "waiting_on_someone",
      unit: `unit_${pad(5)}`,
    }),
  ];
  expect(book({ observations: waits })[0]).toMatchObject({
    next: { text: "The shop answers" },
    status: "waiting_on_someone",
    waitingOn: [SHOP],
  });
});

test("a lone open observation or to-do item is a matter of one; a to-do item made from it joins it", () => {
  const todo = (n: number, over: object, ref?: string) => ({
    at: "2026-10-18T12:00:00.000Z",
    fields: { title: `Item ${n}`, ...over },
    key: `entry_${pad(n)}`,
    ref,
  });
  const lone = [
    obs(21, "2026-10-18", { text: "Send Ana the plans" }),
    obs(22, "2026-10-18", { speaker: GRAN, text: "Gran wants a lift" }),
    obs(23, "2026-10-18", { importance: 2, text: "A small to-do" }),
    obs(24, "2026-10-18", { text: "Ended promise", type: "promise" }),
  ];
  const all = matterBookOf(
    [],
    records({
      endings: new Set([lone[3]?.id as string]),
      observations: lone,
      todoItems: [
        todo(1, { urgent: true }, lone[0]?.id),
        todo(2, {}),
        todo(3, { completed: true }),
      ],
    }),
    "2026-10-19"
  );
  const first = obs(21, "", {}).id;
  const b = all.find((v) => v.id === first);
  // Only his own top-importance to-do (not Gran's request, not a rated-2 one, not the ended promise) and the open items.
  expect(all.map((v) => v.id).toSorted()).toEqual(
    [`entry_${pad(2)}`, first].toSorted()
  );
  expect(b).toMatchObject({ lone: true, next: { kind: "todo_item" } });
  expect(b?.steps.map((s) => s.ref)).toEqual([first, `entry_${pad(1)}`]);
  const ranked = openItems(matterItems(all, nameOf, "2026-10-19"), {
    date: "2026-10-19",
    today: "2026-10-19",
  });
  // Undated: shown the day after it was said (18 Oct); the urgent one first.
  expect(ranked.map((i) => i.id)).toEqual([first, `entry_${pad(2)}`]);
  expect(dayLines({ due: ranked.map((i) => i.line) })[0]).toStartWith(
    "Due (open items"
  );
});

test("a person's page lists the open matters they are in, what he owes first, then what he waits on", () => {
  const waits = [
    ...observations,
    obs(6, "2026-10-17", {
      subjects: [OWNER, SHOP],
      text: "The shop answers",
      type: "waiting_on_someone",
    }),
  ];
  const items = matterItems(
    book({ observations: waits }),
    nameOf,
    "2026-10-20"
  );
  const lines = openWithOf(GRAN, { goals: [], items, today: "2026-10-20" });
  expect(lines[1]).toStartWith("Open with them");
  expect(lines.join("\n")).toContain("owed to Gran");
  // The partner is only with: she is in the matter, so it is listed for her too; a stranger has none.
  expect(
    openWithOf(PARTNER, { goals: [], items, today: "2026-10-20" })
  ).not.toEqual([]);
  expect(
    openWithOf("person:cy", { goals: [], items, today: "2026-10-20" })
  ).toEqual([]);
});

test("an episode and an observation of one day order by instant, in his zone", () => {
  const day = "2026-10-12";
  const at = (n: number, start: string | null, title: string) => ({
    ...episode(n, day, title, []),
    start,
  });
  // Berlin is UTC+2 that day: 11:00 local is 09:00Z, before the 10:00Z promise; 13:00 local is after it.
  const eps = [
    at(21, `${day} 13:00`, "Late call"),
    at(22, `${day} 11:00`, "Early call"),
    at(23, null, "Untimed"),
  ];
  const [view] = matterBookOf(
    [
      {
        areas: [],
        id: "matter_bbbbbbbbbbbb",
        name: "Order",
        projects: [],
        steps: [
          ...[21, 22, 23].map((n) => ({ ref: `unit_${pad(n)}` })),
          { ref: obs(5, "", {}).id },
        ],
      },
    ],
    records({
      episodeOf: new Map(eps.flatMap((m) => m.units.map((u) => [u, m]))),
    }),
    "2026-10-13"
  );
  expect(view?.steps.map((s) => s.text)).toEqual([
    "Untimed",
    "Early call",
    "Call the shop",
    "Late call",
  ]);
});

// audit-1-apple-open-loop: a plan he said aloud to no one (call the shop before buying the train) had no owner, so no
// one nudged him. `read_day` lists it as due on its day, as a matter of one; never someone else's to-do, a sender's or
// one already ended. Up to a week late it is still listed, labelled (a missed daily review), and what he waits on, on
// its day (#99).

test("audit-1-apple-open-loop: day lists the open to-dos and promises of the day or up to a week late, and waiting items on their day", () => {
  const loop = (n: number, over: Partial<Observation>) =>
    ({
      area: null,
      at: "2026-10-18T17:12:59.670Z",
      date: "2026-10-18",
      id: `obs_${String(n).padStart(12, "0")}`,
      importance: 3,
      quote: "tomorrow I'm going to call them",
      speaker: OWNER,
      subjects: [OWNER],
      text: "Call the shop to ask for a morning pickup before booking the train.",
      type: "to_do",
      unit: "unit_000000000001",
      when: "2026-10-19",
      ...over,
    }) as unknown as Observation;
  const JEAN = "person:jean";
  const loops = [
    loop(1, {}),
    // His promise to Jean, whose words a sender wrote: owed to him by name, never left out (decision 11b).
    loop(2, { speaker: JEAN, subjects: [OWNER, JEAN], type: "promise" }),
    // Someone else's to-do, a sender's: not his.
    loop(3, { speaker: JEAN }),
    loop(4, { speaker: "unknown:shop@mail.test" }),
    // His own to-do filed under a project is still his.
    loop(5, { subjects: [OWNER, "project:house"] }),
    // Ended: a later observation shows it done.
    loop(6, {}),
    loop(7, { when: "2026-10-20" }),
    loop(8, { importance: 2 }),
    loop(9, { type: "news" }),
    loop(10, { speaker: JEAN, subjects: [OWNER, JEAN], type: "promise" }),
    // Late: 3 and 7 days overdue are listed (labelled), 8 days is not.
    loop(11, { when: "2026-10-16" }),
    loop(15, { when: "2026-10-12" }),
    loop(12, { when: "2026-10-11" }),
    // What he waits on from someone: on its day only.
    loop(13, { subjects: [OWNER, JEAN], type: "waiting_on_someone" }),
    loop(14, { type: "waiting_on_someone", when: "2026-10-18" }),
    // Undated: the day after it was said (18 Oct), not two days after.
    loop(16, { when: null }),
    loop(17, { date: "2026-10-17", when: null }),
  ];
  const all = matterBookOf(
    [],
    {
      endings: new Set(["obs_000000000006"]),
      episodeOf: new Map(),
      ledger: [],
      observations: loops,
      refOf: (r) => r,
      todoItems: [],
    },
    "2026-10-19"
  );
  const lines = openItems(
    matterItems(all, (r) => r.replace("person:", ""), "2026-10-19"),
    {
      date: "2026-10-19",
      goals: [],
      levels: new Map(),
      shown: new Map(),
      today: "2026-10-19",
    }
  );
  // Ranked: his promises first, then his to-dos, then what he waits on.
  expect(lines.map((l) => l.id.slice(-2))).toEqual([
    "02",
    "10",
    "01",
    "05",
    "11",
    "15",
    "16",
    "13",
  ]);
  expect(lines.filter((l) => l.overdue).map((l) => l.id.slice(-2))).toEqual([
    "11",
    "15",
  ]);
  // Who it is owed to, when not him, is named.
  expect(lines[0]?.line).toContain("owed to jean");
  expect(dayLines({ due: lines.map((l) => l.line) })[0]).toStartWith(
    "Due (open items"
  );
});

test("a unit no episode holds still gives its observations; a retired one is ended; his own to-do is not owed to anyone", () => {
  const unit = `unit_${pad(30)}`;
  const own = obs(30, "2026-10-18", { text: "Pay the plumber", unit });
  const retired = obs(31, "2026-10-18", { text: "Old errand", unit });
  const small = obs(32, "2026-10-18", {
    importance: 1,
    text: "A detail",
    unit,
  });
  const ask = obs(33, "2026-10-18", {
    speaker: GRAN,
    subjects: [OWNER, GRAN],
    text: "Gran asks for a lift",
    unit,
  });
  const [view] = matterBookOf(
    [
      {
        areas: [],
        id: "matter_cccccccccccc",
        name: "Plumber",
        projects: [],
        steps: [{ ref: unit }],
      },
    ],
    records({
      endings: new Set([retired.id]),
      episodeOf: new Map(),
      observations: [own, retired, small, ask],
    }),
    "2026-10-19"
  );
  expect(view?.steps.map((s) => [s.text, s.ended])).toEqual([
    ["Pay the plumber", false],
    ["Old errand", true],
    ["Gran asks for a lift", false],
  ]);
  expect(view?.owedTo).toEqual([GRAN]);
  // His own to-do naming Gran is not owed to her.
  const mine = obs(34, "2026-10-18", {
    subjects: [OWNER, GRAN],
    text: "Mend the gate",
  });
  const [other] = matterBookOf(
    [],
    records({ observations: [mine] }),
    "2026-10-19"
  );
  expect(other?.owedTo).toEqual([]);
});
