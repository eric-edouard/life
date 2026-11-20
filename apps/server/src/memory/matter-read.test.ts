import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import type { Observation } from "../records/observation";
import {
  doneOnOf,
  isEnded,
  type MatterRecords,
  matterBookOf,
} from "./matter-read";
import { openItems } from "./open-items";
import { dayLines } from "./read-day";
import { matterItems, openWithOf } from "./read-open-items";
import { OWNER } from "./read-truth";
import { isMailerHandle } from "./units";

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
const MAILERS = new Set([
  "unknown:no-reply@bank.test",
  "unknown:alerts@agents.test",
]);
const records = (over: Partial<MatterRecords> = {}): MatterRecords => ({
  current: new Set(),
  directions: [],
  episodeOf: new Map(episodes.flatMap((m) => m.units.map((u) => [u, m]))),
  icons: [],
  important: [],
  isMailer: (r) => MAILERS.has(r),
  ledger: [],
  linkEndings: new Map(),
  observations,
  refOf: (r) => r,
  retired: new Map(),
  todoItems: [],
  ...over,
});
/** Observations said outdated on 19 Oct: retired for sure. */
const gone = (...ids: string[]) =>
  new Map(
    ids.map((id) => [id, { at: "2026-10-19T09:00:00Z", why: "outdated" }])
  );
/** Stored matter lines as `mattersNow` gives them: `offered`, the records a matters call was shown. */
const stored = (
  matters: Parameters<typeof matterBookOf>[0]["matters"],
  offered: string[] = []
) => ({ matters, offered: new Set(offered) });
const book = (over: Partial<MatterRecords> = {}, today = "2026-10-20") =>
  matterBookOf(stored([line]), records(over), today);

test("the errand: moving, next 'call the shop', owed to Gran; the partner's old suggestion and the episodes' casts are not its people", () => {
  const [errand, ...rest] = book();
  expect(rest).toEqual([]);
  expect(errand).toMatchObject({
    areas: ["family"],
    newestOpenStep: { kind: "promise", text: "Call the shop" },
    open: true,
    owedTo: [GRAN],
    projects: ["shop-fit-out"],
    status: "moving",
    waitingOn: [],
    with: [],
  });
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

// His report of 19 Nov 2026: a court case listed a friend from a dinner, a shop colleague and an old helper "with" and
// "told", because a matter's people were the casts of every episode its steps touched, ended or not. Its people are
// where it stands now: the people its open steps name.
test("a matter's people are its open steps' people: never a sitting's cast, never an ended step's person", () => {
  const [DAD, LAWYER, FRIEND, NEIGHBOUR, HELPER] = [
    "person:dad",
    "person:lawyer",
    "person:friend",
    "person:neighbour",
    "person:helper",
  ];
  const steps = [
    // Dad asks him to find a lawyer, on a call.
    obs(70, "2026-10-12", { speaker: DAD, subjects: [OWNER, DAD] }),
    // His own to-do: send the report to the lawyer.
    obs(71, "2026-10-13", { subjects: [OWNER, LAWYER] }),
    // Said in passing at a dinner with a friend, on other subjects: a fact, not where it stands.
    obs(72, "2026-10-14", {
      importance: 2,
      subjects: [OWNER, DAD],
      type: "news",
    }),
    // A promise to an old helper, ended.
    obs(73, "2026-10-05", { subjects: [OWNER, HELPER], type: "promise" }),
  ];
  const dinner = episode(72, "2026-10-14", "Dinner with a friend", [
    [FRIEND, "with"],
    [NEIGHBOUR, "told"],
  ]);
  const [court] = matterBookOf(
    stored([
      {
        areas: [],
        id: "matter_cccccccccccc",
        name: "Court case",
        projects: [],
        steps: steps.map((o) => ({ ref: o.id })),
      },
    ]),
    records({
      episodeOf: new Map([[dinner.units[0] as string, dinner]]),
      observations: steps,
      retired: gone(obs(73, "", {}).id),
    }),
    "2026-10-20"
  );
  // An observation step brings no sitting: the dinner is no step of it.
  expect(court?.steps.map((s) => s.text)).not.toContain("Dinner with a friend");
  expect(court).toMatchObject({ owedTo: [DAD], waitingOn: [], with: [LAWYER] });
});

test("a matter's status: done when every open step is ended, stuck when the next step's date passed, waiting, dormant", () => {
  const [ask, promise] = [obs(1, "", {}).id, obs(5, "", {}).id];
  expect(book({ retired: gone(ask, promise) })[0]?.status).toBe("done");
  // One ended step does not close a matter while another is open, whichever is newer.
  expect(book({ retired: gone(ask) })[0]?.open).toBe(true);
  expect(book({ retired: gone(promise) })[0]).toMatchObject({
    newestOpenStep: { text: "Get Gran's watch repaired" },
    open: true,
  });
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
  // The next step's passed date is stuck at any age.
  expect(book({ observations: due }, "2026-12-30")[0]?.status).toBe("stuck");
  // An older open step's date counts only within 30 days: past that it no longer makes the matter stuck.
  const older = observations.map((o) =>
    o.id === ask ? { ...o, when: "2026-10-05" } : o
  );
  expect(book({ observations: older }, "2026-10-20")[0]?.status).toBe("stuck");
  expect(book({ observations: older }, "2026-11-20")[0]?.status).toBe(
    "dormant"
  );
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
    newestOpenStep: { text: "The shop answers" },
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
    stored([]),
    records({
      observations: lone,
      retired: gone(lone[3]?.id as string),
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
  expect(b).toMatchObject({
    lone: true,
    newestOpenStep: { kind: "todo_item" },
  });
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
  const lines = openWithOf(GRAN, {
    goals: [],
    items,
    owner: "Test",
    today: "2026-10-20",
  });
  expect(lines[1]).toStartWith("Open with them");
  expect(lines.join("\n")).toContain("owed to Gran");
  // The partner only made a suggestion, long settled, and the shop is waited on: neither is listed for the partner.
  for (const who of [PARTNER, "person:cy"]) {
    expect(
      openWithOf(who, { goals: [], items, owner: "Test", today: "2026-10-20" })
    ).toEqual([]);
  }
});

test("a person's open items: the pointer counts what the one cut left out, and is absent when all fit", () => {
  const items = matterItems(book({ observations }), nameOf, "2026-10-20");
  const mine = items.filter(
    (i) => i.person === GRAN || i.people?.includes(GRAN)
  );
  const call = (room?: number) =>
    openWithOf(GRAN, {
      goals: [],
      items,
      owner: "Test",
      room,
      today: "2026-10-20",
    }).join("\n");
  expect(mine.length).toBeGreaterThan(0);
  expect(call()).not.toContain("more open with them");
  const none = call(1);
  expect(none).toContain(
    `${new Set(mine.map((i) => i.id)).size} more open with them`
  );
  expect(none).not.toContain("owed to Gran");
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
    stored([
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
    ]),
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
    stored([]),
    records({
      episodeOf: new Map(),
      observations: loops,
      retired: gone("obs_000000000006"),
    }),
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
  // Ranked: what is overdue first, then his promises, then his to-dos, then what he waits on.
  expect(lines.map((l) => l.id.slice(-2))).toEqual([
    "11",
    "15",
    "02",
    "10",
    "01",
    "05",
    "16",
    "13",
  ]);
  expect(lines.filter((l) => l.overdue).map((l) => l.id.slice(-2))).toEqual([
    "11",
    "15",
  ]);
  // Who it is owed to, when not him, is named.
  expect(lines[2]?.line).toContain("owed to jean");
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
    stored([
      {
        areas: [],
        id: "matter_cccccccccccc",
        name: "Plumber",
        projects: [],
        steps: [{ ref: unit }],
      },
    ]),
    records({
      episodeOf: new Map(),
      observations: [own, retired, small, ask],
      retired: gone(retired.id),
    }),
    "2026-10-19"
  );
  expect(view?.steps.map((s) => [s.text, isEnded(s)])).toEqual([
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
    stored([]),
    records({ observations: [mine] }),
    "2026-10-19"
  );
  expect(other?.owedTo).toEqual([]);
});

test("a link ends its step at once: the matter reads probably done, the step shows the words that ended it", () => {
  const [ask, promise] = [obs(1, "", {}).id, obs(5, "", {}).id];
  const linked = new Map([
    [
      promise,
      {
        at: "2026-10-16T09:00:00Z",
        later: "ep_000000000005",
        quote: "I called the shop",
      },
    ],
  ]);
  // Another step still open: the matter stays open, its next step the open one.
  const [open] = book({ linkEndings: linked });
  expect(open).toMatchObject({ newestOpenStep: { ref: ask }, open: true });
  expect(open?.steps.find((s) => s.ref === promise)?.ending).toEqual({
    at: "2026-10-16T09:00:00Z",
    by: "link",
    quote: "I called the shop",
  });
  const [probably] = book({ linkEndings: linked, retired: gone(ask) });
  expect(probably).toMatchObject({ open: false, status: "probably_done" });
  // His word (the step retired) makes it done.
  const [done] = book({ retired: gone(ask, promise) });
  expect(done?.status).toBe("done");
});

test("a placed observation brings no episode: only a unit step does", () => {
  const [view] = matterBookOf(
    stored([{ ...line, steps: [{ ref: obs(5, "", {}).id }] }]),
    records(),
    "2026-10-20"
  );
  expect(view?.steps.map((s) => s.text)).toEqual(["Call the shop"]);
  const [byUnit] = matterBookOf(
    stored([{ ...line, steps: [{ ref: obs(5, "", {}).unit }] }]),
    records(),
    "2026-10-20"
  );
  expect(byUnit?.steps.map((s) => s.kind)).toContain("episode");
});

// stale-1-finished-matter-offered, stale-5-second-phantom-of-one-meeting: one voice unit held by two episodes of a day
// (a repair, a swim with a friend), of which `episodeOf` keeps the swim; the matter's only step is an observation of it.
test("stale-1-finished-matter-offered, stale-5-second-phantom-of-one-meeting: an observation step holds no sitting, so its friend is no one's", () => {
  const FRIEND = "person:friend";
  const said = obs(60, "2026-10-14", {
    text: "Drop the bike at the repair shop",
  });
  // `episodeOf` keeps one episode per unit: here the swim, not the repair.
  const swim = episode(61, "2026-10-14", "Swim with a friend", [
    [FRIEND, "with"],
  ]);
  const [view] = matterBookOf(
    stored([{ ...line, steps: [{ ref: said.id }] }]),
    records({
      episodeOf: new Map([[said.unit, swim]]),
      observations: [said],
    }),
    "2026-10-20"
  );
  expect(view?.steps.map((s) => s.kind)).toEqual(["to_do"]);
  for (const people of [view?.with, view?.owedTo, view?.waitingOn]) {
    expect(people).not.toContain(FRIEND);
  }
});

test("a placed observation whose unit no episode holds attaches no episode", () => {
  const lost = obs(31, "2026-10-18", {
    text: "Call the shop again",
    unit: `unit_${pad(99)}`,
  });
  const [view] = matterBookOf(
    stored([{ ...line, steps: [{ ref: lost.id }] }]),
    records({ observations: [lost] }),
    "2026-10-20"
  );
  expect(view?.steps.map((s) => s.text)).toEqual(["Call the shop again"]);
});

// matters-study-2026-11-16 (P1): a recording placed in a matter pulled in every kept fact of it, even those the matters
// call was shown and left out ("call the nanny" inside "Send the builder a notice letter"). A fact the call saw and did
// not place stays out; one no call has seen yet still comes with its unit.
test("matters-study P1: a fact the matters call was shown and left out is not pulled back with its unit", () => {
  const unit = `unit_${pad(40)}`;
  const letter = obs(40, "2026-10-18", {
    text: "Send the builder the letter",
    unit,
  });
  const nanny = obs(41, "2026-10-18", { text: "Call the nanny", unit });
  const fresh = obs(42, "2026-10-18", {
    text: "Add the photos to the letter",
    unit,
  });
  const [view] = matterBookOf(
    stored(
      [
        {
          areas: [],
          id: "matter_dddddddddddd",
          name: "Letter",
          projects: [],
          steps: [{ ref: unit }, { ref: letter.id }],
        },
      ],
      [unit, letter.id, nanny.id]
    ),
    records({ episodeOf: new Map(), observations: [letter, nanny, fresh] }),
    "2026-10-19"
  );
  expect(view?.steps.map((s) => s.text).toSorted()).toEqual([
    "Add the photos to the letter",
    "Send the builder the letter",
  ]);
});

// matters-study-2026-11-16 (P2): a trip or an event holds no to-do, promise or wait, so nothing could ever end it
// (the Koh Samet weekend read open two months after). Done once its last step and every date are a week past.
test("matters-study P2: a matter with nothing to do is done once a week has passed its last step and date", () => {
  const trip = {
    areas: [],
    id: "matter_eeeeeeeeeeee",
    name: "Weekend at the beach",
    projects: [],
    steps: [{ ref: `unit_${pad(2)}` }],
  };
  const at = (today: string, over: Partial<Observation> = {}) =>
    matterBookOf(
      stored([trip]),
      records({
        observations: [
          obs(2, "2026-10-03", { importance: 2, type: "choice", ...over }),
        ],
      }),
      today
    )[0];
  // Nothing to do: every step is current, so the people taking part in its episodes are its people.
  expect(at("2026-10-08")).toMatchObject({
    open: true,
    status: "moving",
    with: [PARTNER],
  });
  expect(at("2026-10-11")).toMatchObject({ open: false, status: "done" });
  // A date ahead keeps it going until a week after that date.
  expect(at("2026-10-20", { when: "2026-10-18" })?.open).toBe(true);
  expect(at("2026-10-26", { when: "2026-10-18" })?.open).toBe(false);
});

// matters-study-2026-11-16 (P5): "owed to" named mail senders: 29 open matters were owed to his agents' report
// address, 7 to a no-reply sender. A to-do is owed only to the person who asked it: one a mailer or his agent sent is owed to no one, with the person it names.
test("matters-study P5: owed to never names a no-reply sender or his agents' reports", () => {
  const bill = obs(50, "2026-10-18", {
    speaker: "unknown:no-reply@bank.test",
    subjects: [OWNER, GRAN, "unknown:no-reply@bank.test"],
    text: "Pay Gran's bank fee",
  });
  const report = obs(51, "2026-10-18", {
    speaker: "unknown:alerts@agents.test",
    text: "Decide on the shop's quote",
  });
  const views = matterBookOf(
    stored([]),
    records({ observations: [bill, report] }),
    "2026-10-19"
  );
  // His own top to-dos only are lone matters; build them as a stored matter to read their people.
  const [view] = matterBookOf(
    stored([
      {
        areas: [],
        id: "matter_ffffffffffff",
        name: "Bills",
        projects: [],
        steps: [{ ref: bill.id }, { ref: report.id }],
      },
    ]),
    records({ episodeOf: new Map(), observations: [bill, report] }),
    "2026-10-19"
  );
  expect(views).toEqual([]);
  expect(view).toMatchObject({ owedTo: [], waitingOn: [], with: [GRAN] });
});

test("matters-study P5: a mailer handle is a no-reply spelling or a failed-payment sender, never a person's address", () => {
  for (const h of [
    "no-reply@bank.test",
    "no_reply@email.shop.test",
    "do_not_reply@mailer.test",
    "nepasrepondre@annuaire.test",
    "noreplay@store.test",
    "cloudplatform-noreply@cloud.test",
    "failed-payments+acct_1@pay.test",
  ]) {
    expect([h, isMailerHandle(h)]).toEqual([h, true]);
  }
  for (const h of ["ann@mail.test", "support@pay.test", "renoir@art.test"]) {
    expect([h, isMailerHandle(h)]).toEqual([h, false]);
  }
});

// What got done (his ask of 16 Nov 2026: an agent or a link closes things; he still sees what was done, when it was
// done, never when a run found it).
test("what got done on a day: closed matters by the instant their last step ended, with how", () => {
  const [ask, promise] = [obs(1, "", {}).id, obs(5, "", {}).id];
  const ended = matterBookOf(
    stored([line]),
    records({
      retired: new Map([
        [ask, { at: "2026-10-17T08:00:00Z", why: "outdated" }],
        [
          promise,
          {
            at: "2026-10-18T15:00:00Z",
            why: "the agent posted the watch back",
          },
        ],
      ]),
    }),
    "2026-10-20"
  );
  const day = (at: string) => at.slice(0, 10);
  expect(doneOnOf(ended, "2026-10-17", day)).toEqual([]);
  const [done] = doneOnOf(ended, "2026-10-18", day);
  expect(done?.matter.name).toBe("Mend Gran's watch");
  expect(done?.last.ending).toEqual({
    at: "2026-10-18T15:00:00Z",
    by: "record",
    why: "the agent posted the watch back",
  });
  // A matter still open is never listed, whatever its steps' endings.
  const open = matterBookOf(
    stored([line]),
    records({ retired: gone(promise) }),
    "2026-10-20"
  );
  expect(doneOnOf(open, "2026-10-19", day)).toEqual([]);
});

test("read_day lists what got done that day after what is due", () => {
  const lines = dayLines({
    done: [
      "- matter_aaaaaaaaaaaa Mend Gran's watch [done]: Call the shop (ticked 2026-10-18)",
    ],
    due: ["- a due line"],
  });
  expect(lines.indexOf("Done (matters that ended this day, and how):")).toBe(3);
  expect(lines[4]).toContain("(ticked 2026-10-18)");
});
