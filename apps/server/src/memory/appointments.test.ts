import { expect, test } from "bun:test";
import { type Appointment, Appointments } from "../records/appointment";
import type { Observation } from "../records/observation";
import {
  checkedAppointments,
  heldIdsOf,
  observationsAheadOf,
} from "./appointments";
import type { ObservationStatusInputs } from "./memory-files";

const UNIT = "unit_000000000001";
const NEW_ID = /^apt_[0-9a-f]{12}$/;
const fact = (id: string, over: Partial<Observation> = {}) =>
  ({
    date: "2026-11-08",
    id,
    madeBy: { run: "r1", unitHash: "h" },
    modality: "plan",
    unit: UNIT,
    when: null,
    ...over,
  }) as Observation;
const statusInputs = (retired: string[] = []): ObservationStatusInputs => ({
  corrections: [],
  latest: new Map(),
  live: new Set([UNIT]),
  retired: new Map(
    retired.map((id) => [id, { by: "obs_ffffffffffff" }])
  ) as ObservationStatusInputs["retired"],
});

test("the step reads what is ahead (plans and facts, never a hypothesis), recent undated plans, and what a held appointment cites", () => {
  const facts = [
    fact("obs_000000000001", { when: "2026-11-11" }),
    fact("obs_000000000002", { when: "2026-11-01" }),
    fact("obs_000000000003", { date: "2026-11-03" }),
    fact("obs_000000000004", { date: "2026-09-01" }),
    fact("obs_000000000005", { date: "2026-09-01" }),
    fact("obs_000000000006", { modality: "fact", when: "2026-11-20" }),
    fact("obs_000000000007", { when: "2026-11-20" }),
    fact("obs_000000000009", { modality: "conditional", when: "2026-11-20" }),
    fact("obs_00000000000a", { date: "2026-11-03", modality: "fact" }),
  ];
  const read = observationsAheadOf(
    facts,
    statusInputs(["obs_000000000007"]),
    "2026-11-08",
    new Set(["obs_000000000005"])
  );
  expect(read.map((o) => o.id)).toEqual([
    "obs_000000000001",
    "obs_000000000003",
    "obs_000000000005",
    "obs_000000000006",
  ]);
});

const ctx = {
  held: [
    {
      allDay: false,
      end: "2026-11-11 17:00",
      id: "apt_000000000001",
      observations: ["obs_000000000001"],
      place: null,
      start: "2026-11-11 16:00",
      timeGuessed: true,
      title: "Clinic",
      zone: null,
    },
  ] as Appointment[],
  refused: [["obs_00000000000f"]],
  replacedBy: (f: string) =>
    f === "obs_00000000000c" ? "obs_00000000000d" : undefined,
  shown: new Set(["obs_000000000001", "obs_000000000002", "obs_00000000000f"]),
  today: "2026-11-08",
};
const reply = (over: Record<string, unknown>) => ({
  allDay: false,
  end: "2026-11-11 17:00",
  facts: ["obs_000000000001"],
  place: "The clinic",
  start: "2026-11-11 16:00",
  timeGuessed: false,
  title: "Session at the clinic",
  ...over,
});

test("a reply keeps only appointments on facts it was shown, with a held id or a new one from their facts", () => {
  const { appointments, invalid } = checkedAppointments(
    {
      appointments: [
        reply({}),
        reply({
          allDay: true,
          end: "2026-11-19",
          facts: ["obs_000000000002"],
          start: "2026-11-17",
          title: "Trip to the north",
        }),
        // A fact it was not shown, a refused fact, an ended one, a timed one written as days, and garbage.
        reply({ facts: ["obs_000000000009"] }),
        reply({ facts: ["obs_00000000000f"] }),
        reply({ end: "2026-11-07 17:00", start: "2026-11-07 16:00" }),
        reply({ end: "2026-11-11", start: "2026-11-11" }),
        "dinner",
      ],
    },
    ctx
  );
  expect(invalid).toBe(5);
  expect(appointments.map((a) => a.id)).toEqual([
    "apt_000000000001",
    expect.stringMatching(NEW_ID),
  ]);
  // A new id is its facts': the same reading gives the same id.
  const again = checkedAppointments(
    { appointments: [reply({ facts: ["obs_000000000002"] })] },
    ctx
  );
  expect(again.appointments[0]?.id).toBe(appointments[1]?.id as string);
  expect(appointments[1]).toMatchObject({
    allDay: true,
    observations: ["obs_000000000002"],
    place: "The clinic",
  });
});

test("code keeps the ids: a held one goes to the reading most like it, once; a reading of the same facts twice counts once", () => {
  const { appointments, invalid } = checkedAppointments(
    {
      appointments: [
        reply({
          facts: ["obs_000000000001", "obs_000000000002"],
          title: "Trip",
        }),
        reply({}),
        reply({ title: "Again" }),
        // A place written empty is no place, never a file that no longer reads.
        reply({ facts: ["obs_000000000002"], place: "" }),
      ],
    },
    ctx
  );
  expect(invalid).toBe(1);
  expect(
    appointments.map((a) => [a.title, a.id === "apt_000000000001"])
  ).toEqual([
    ["Trip", false],
    ["Session at the clinic", true],
    ["Session at the clinic", false],
  ]);
  expect(appointments[2]?.place).toBeNull();
  expect(() =>
    Appointments.shape.appointments.parse(appointments)
  ).not.toThrow();
});

test("a new reading never takes an id another appointment has: a held one first read from its facts keeps it", () => {
  const first = checkedAppointments(
    { appointments: [reply({})] },
    { ...ctx, held: [] }
  ).appointments[0] as Appointment;
  const grown = {
    ...first,
    observations: ["obs_000000000001", "obs_000000000002"],
  };
  const { appointments } = checkedAppointments(
    {
      appointments: [
        reply({
          facts: ["obs_000000000001", "obs_000000000002"],
          title: "Trip",
        }),
        reply({ title: "Inside it" }),
      ],
    },
    { ...ctx, held: [grown] }
  );
  expect(appointments.map((a) => [a.title, a.id === first.id])).toEqual([
    ["Trip", true],
    ["Inside it", false],
  ]);
  expect(new Set(appointments.map((a) => a.id)).size).toBe(2);
});

test("a held appointment whose fact a newer one replaced keeps its id on a reading of the newer", () => {
  expect(
    heldIdsOf(
      [["obs_00000000000d"]],
      [{ facts: ["obs_00000000000d"], id: "apt_000000000009" }]
    )
  ).toEqual(["apt_000000000009"]);
  const { appointments } = checkedAppointments(
    { appointments: [reply({ facts: ["obs_00000000000d"] })] },
    {
      ...ctx,
      held: [
        { ...ctx.held[0], observations: ["obs_00000000000c"] } as Appointment,
      ],
      shown: new Set(["obs_00000000000d"]),
    }
  );
  expect(appointments.map((a) => a.id)).toEqual(["apt_000000000001"]);
});

test("a held appointment the reply forgets stays while its facts hold and it has not ended", () => {
  const forgot = { appointments: [reply({ facts: ["obs_000000000002"] })] };
  expect(
    checkedAppointments(forgot, ctx).appointments.map((a) => a.id)
  ).toContain("apt_000000000001");
  // Its fact retired (no longer shown), or the appointment past: it goes.
  const gone = { ...ctx, shown: new Set(["obs_000000000002"]) };
  expect(
    checkedAppointments(forgot, gone).appointments.map((a) => a.id)
  ).not.toContain("apt_000000000001");
  const later = { ...ctx, today: "2026-11-12" };
  expect(
    checkedAppointments(forgot, later).appointments.map((a) => a.id)
  ).not.toContain("apt_000000000001");
});

test("a new reading that cites a held one's fact replaces it; his no holds for any reading citing all its facts", () => {
  const { appointments } = checkedAppointments(
    {
      appointments: [
        reply({ facts: ["obs_000000000001", "obs_000000000002"] }),
        reply({ facts: ["obs_000000000002", "obs_00000000000f"] }),
      ],
    },
    ctx
  );
  // One appointment, not the held one beside a copy; the one citing the refused fact stays out.
  expect(appointments).toHaveLength(1);
  expect(appointments[0]?.observations).toEqual([
    "obs_000000000001",
    "obs_000000000002",
  ]);
  expect(
    checkedAppointments(
      { appointments: [reply({ zone: "Mars/Olympus" })] },
      ctx
    ).invalid
  ).toBe(1);
});
