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
  endings: new Map(),
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
  expect(book({ endings: new Map([[promise, {}]]) })[0]?.status).toBe("done");
  // The older to-do ended does not close a matter whose newest to-do or promise is open.
  expect(book({ endings: new Map([[obs(1, "", {}).id, {}]]) })[0]?.open).toBe(
    true
  );
  expect(book({}, "2026-11-20")[0]?.status).toBe("stuck");
  expect(book({}, "2026-12-30")[0]).toMatchObject({
    open: true,
    status: "dormant",
  });
  const due = observations.map((o) =>
    o.type === "promise" ? { ...o, when: "2026-10-18" } : o
  );
  expect(book({ observations: due })[0]?.status).toBe("stuck");
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
      endings: new Map([[lone[3]?.id as string, {}]]),
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
  const ranked = openItems(matterItems(all, nameOf), {
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
  const items = matterItems(book({ observations: waits }), nameOf);
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
