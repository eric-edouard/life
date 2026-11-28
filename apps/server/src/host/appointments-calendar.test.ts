import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { appendJsonl } from "../core/files";
import { setSettings, settings } from "../core/settings";
import { readAppointmentEvents } from "../memory/appointments";
import {
  APPOINTMENT_EVENTS,
  APPOINTMENTS,
  readReplyPath,
} from "../memory/memory-files";
import { plannedOf } from "../memory/planned-appointments";
import { readAppointmentSheet } from "../memory/read-appointments";
import { READS, storeReply } from "../memory/read-replies";
import type { People } from "../memory/who";
import { type Appointment, AppointmentEvent } from "../records/appointment";
import type { ReadReply } from "../records/read-reply";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as push from "../sources/voice-server-push";
import {
  appointmentDraft,
  drafted,
  removeAppointment,
  restoreAppointment,
  syncAppointments,
} from "./appointments-calendar";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as google from "./google-calendar";
import { rpc, token } from "./http/mcp-test-harness";
import { expectWire } from "./http/wire-fixture";

const appointment = (over: Partial<Appointment> = {}): Appointment => ({
  allDay: false,
  end: "2026-11-11 17:00",
  id: "apt_000000000001",
  observations: ["obs_000000000001"],
  place: "The clinic",
  start: "2026-11-11 16:00",
  timeGuessed: true,
  title: "Session at the clinic",
  zone: null,
  ...over,
});

test("an appointment at a place carries its map links by name; one with no place has none", () => {
  expect(appointmentDraft(appointment(), false).text).toContain(
    "Google Maps: https://www.google.com/maps/search/?api=1&query=The%20clinic\nApple Maps: https://maps.apple.com/?q=The%20clinic\n"
  );
  // A long place and a long list of facts: the links stay, the text fits Google's 8,192.
  const long = appointmentDraft(
    appointment({
      observations: Array.from(
        { length: 500 },
        (_, i) => `obs_${`${i}`.padStart(12, "0")}`
      ),
      place: "ที่".repeat(66),
    }),
    false
  ).text;
  expect(long.length).toBeLessThan(8192);
  expect(long).toContain("Apple Maps: ");
  expect(
    appointmentDraft(appointment({ place: null }), false).text
  ).not.toContain("maps");
});

test("an unconfirmed appointment is marked (Life); confirming it changes its event, its time guess is said", () => {
  const open = appointmentDraft(appointment(), false);
  const sure = appointmentDraft(appointment(), true);
  expect(open.summary).toBe("(Life) Session at the clinic");
  expect(sure.summary).toBe("Session at the clinic");
  expect(open.hash).not.toBe(sure.hash);
  expect(open.text).toContain("not confirmed yet");
  expect(open.text).toContain("The time is Life's guess.");
  expect(open.text).toContain("obs_000000000001");
  expect(open.allDay).toBe(false);
  // A trip of whole days: its last day inclusive, the event's end exclusive.
  const trip = appointmentDraft(
    appointment({ allDay: true, end: "2026-11-19", start: "2026-11-17" }),
    false
  );
  expect(trip).toMatchObject({
    allDay: true,
    from: "2026-11-17",
    to: "2026-11-20",
  });
});

test("an event Life wrote and no longer lists is a refusal only when Google says it is gone", async () => {
  const now = new Date("2026-11-08T10:00:00Z");
  const line = (id: string, event: string) =>
    AppointmentEvent.parse({
      appointment: id,
      at: now.toISOString(),
      calendar: "cal",
      event,
      observations: ["obs_000000000001"],
      op: "created",
      schemaVersion: 1,
    });
  appendJsonl(APPOINTMENT_EVENTS, AppointmentEvent, [
    line("apt_000000000001", "listed"),
    line("apt_000000000002", "deleted"),
    line("apt_000000000003", "moved"),
    line("apt_000000000004", "unreadable"),
    line("apt_000000000006", "gone"),
    { ...line("apt_000000000006", "gone"), op: "removed" },
    { ...line("apt_000000000007", "elsewhere"), calendar: "old" },
  ]);
  const list = [1, 2, 3, 4, 5, 6, 7].map((n) =>
    appointment({ id: `apt_00000000000${n}` })
  );
  const kept = await drafted(
    list,
    new Map([["apt_000000000001", [{ hash: "h", id: "listed" }]]]),
    {
      exists: (id: string) =>
        id === "unreadable"
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(id !== "deleted" && id !== "elsewhere"),
    },
    "cal",
    now
  );
  // Listed, never written here (another calendar's), or removed by Life (back again): drafted; gone: refused; moved
  // or unreadable: left alone this tick.
  expect(kept.map((a) => a.id)).toEqual([
    "apt_000000000001",
    "apt_000000000005",
    "apt_000000000006",
    "apt_000000000007",
  ]);
  const { byAppointment, refused } = readAppointmentEvents();
  expect(byAppointment.get("apt_000000000002")?.op).toBe("refused");
  expect(byAppointment.get("apt_000000000004")?.op).toBe("created");
  expect([...refused.values()]).toEqual([["obs_000000000001"]]);
  // A refused appointment is never drafted again.
  const after = await drafted(
    list.slice(1, 2),
    new Map(),
    {
      exists: () => Promise.resolve(false),
    },
    "cal",
    now
  );
  expect(after).toEqual([]);
});

// The arrival path on made-up data: a fake calendar, made-up replies, nothing reaches Google or a phone.
const NOW = new Date("2031-03-10T09:00:00Z");
const ARRIVAL_AT = "2031-03-10T08:00:00.000Z";
const LATER_AT = "2031-04-01T08:00:00.000Z";
let events: Map<
  string,
  {
    allDay: boolean;
    busy?: boolean;
    props: Record<string, string>;
    summary?: string;
  }
>;
let made = 0;
/** The sheet's reads with nothing to open: its own fields only. */
const noReads = {
  book: () => Promise.resolve([]),
  message: () => null,
  people: () => Promise.resolve({} as People),
};
const fake = {
  create: (
    f: { allDay: boolean; busy: boolean; summary?: string },
    props: Record<string, string>
  ) => {
    made += 1;
    const id = `ev${made}`;
    events.set(id, {
      allDay: f.allDay,
      busy: f.busy,
      props,
      summary: f.summary,
    });
    return Promise.resolve(id);
  },
  exists: (id: string) => Promise.resolve(events.has(id)),
  list: () =>
    Promise.resolve(
      [...events].map(([id, e]) => ({ allDay: e.allDay, id, props: e.props }))
    ),
  read: (id: string) =>
    Promise.resolve(events.has(id) ? { props: events.get(id)?.props } : null),
  remove: (id: string) => {
    if (failDelete) {
      return Promise.reject(new Error("gog calendar delete: offline"));
    }
    events.delete(id);
    return Promise.resolve();
  },
  update: (id: string, f: { busy: boolean; description: string }) => {
    updates.push({ id, ...f });
    return Promise.resolve();
  },
};
const was = settings().appointmentsCalendar;
const nightFile = existsSync(APPOINTMENTS)
  ? readFileSync(APPOINTMENTS, "utf8")
  : null;
let failDelete = false;
let updates: { busy: boolean; description: string; id: string }[] = [];
let calendar: ReturnType<typeof spyOn<typeof google, "googleCalendar">>;
let pushed: ReturnType<typeof spyOn<typeof push, "notifyPhone">>;
const agreed = (start: string, messages: string[], at = ARRIVAL_AT) =>
  storeReply(
    {
      at,
      madeBy: {
        engine: "codex",
        model: "test",
        prompt: READS.arrival_appointment.prompt,
        run: "r1",
      },
      messages,
      promptDigest: "0123456789abcdef",
      read: "arrival_appointment",
      reply: {
        agreed: true,
        allDay: false,
        end: start.replace("10:00", "11:00"),
        link: "https://meet.example.com/kit-lou",
        people: ["Kit"],
        place: null,
        quote: "see you then",
        start,
        title: "Coffee with Kit",
        zone: null,
      },
      schemaVersion: 1,
      starts: [0],
      unit: "unit_0000000000aa",
    } as ReadReply,
    at
  );
const clean = () => {
  rmSync(APPOINTMENT_EVENTS, { force: true });
  rmSync(readReplyPath(ARRIVAL_AT), { force: true });
  rmSync(readReplyPath(LATER_AT), { force: true });
  rmSync(APPOINTMENTS, { force: true });
};
beforeEach(() => {
  clean();
  events = new Map();
  made = 0;
  updates = [];
  failDelete = false;
  setSettings({
    appointmentsCalendar: { account: "a@example.com", calendar: "cal" },
  });
  calendar = spyOn(google, "googleCalendar").mockReturnValue(
    fake as unknown as google.GoogleCalendar
  );
  pushed = spyOn(push, "notifyPhone").mockResolvedValue(true);
});
afterEach(() => {
  calendar.mockRestore();
  pushed.mockRestore();
  setSettings({ appointmentsCalendar: was });
  clean();
  if (nightFile !== null) {
    Bun.write(APPOINTMENTS, nightFile);
  }
});

test("an appointment agreed in new lines is written once, pushed once by an opaque id; the first per start is kept", async () => {
  agreed("2031-03-12 10:00", ["whatsapp|m1"]);
  agreed("2031-03-12 10:00", ["whatsapp|m2"]);
  // One already over is never written.
  agreed("2031-03-01 10:00", ["whatsapp|m3"]);
  expect(await syncAppointments(NOW)).toMatchObject({ created: 1 });
  const [event] = [...events.values()];
  expect(event?.props.lifeOutput).toBe("appointments");
  // He agreed it: busy at once.
  expect(event?.busy).toBe(true);
  const id = event?.props.lifeAppointment ?? "";
  expect(readAppointmentEvents().byAppointment.get(id)).toMatchObject({
    messages: ["whatsapp|m1"],
    op: "created",
  });
  expect(pushed).toHaveBeenCalledTimes(1);
  expect(pushed.mock.calls[0]?.[0]).toEqual({
    body: "Added to your calendar",
    kind: "calendar.added",
    level: "passive",
    pushId: push.pushIdOf(id),
    title: "Life",
  });
  // Written again (deleted by Life, back), never pushed again.
  events.clear();
  appendJsonl(APPOINTMENT_EVENTS, AppointmentEvent, [
    AppointmentEvent.parse({
      ...readAppointmentEvents().byAppointment.get(id),
      op: "removed",
    }),
  ]);
  await syncAppointments(NOW);
  expect(events.size).toBe(1);
  expect(pushed).toHaveBeenCalledTimes(1);
  // Past the window it is read in, its event stays until it ends.
  rmSync(readReplyPath(ARRIVAL_AT), { force: true });
  await syncAppointments(NOW);
  expect(events.size).toBe(1);
});

test("one draft per meeting: the night's and the arrival's of one start are one, agreed with its link, under the id that has an event; one over is left out", () => {
  const arrival = (id: string, start: string, end: string) => ({
    allDay: false,
    at: ARRIVAL_AT,
    end,
    id,
    link: "https://meet.example.com/kit-lou",
    messages: ["whatsapp|m1"],
    place: null,
    quote: "see you then",
    start,
    title: "Coffee with Kit",
    unit: "unit_0000000000aa",
    zone: "UTC",
  });
  const night = [
    appointment({
      end: "2031-03-12 11:00",
      id: "apt_000000000011",
      start: "2031-03-12 10:00",
      zone: "UTC",
    }),
  ];
  const arrivals = [
    arrival("apt_0000000000aa", "2031-03-12 10:00", "2031-03-12 11:00"),
    // Ended at 08:00 today, read late: never written.
    arrival("apt_0000000000bb", "2031-03-10 07:00", "2031-03-10 08:00"),
  ];
  const fresh = plannedOf(night, arrivals, new Map(), () => false, NOW);
  expect(fresh.map((a) => [a.id, "agreed" in a && a.agreed])).toEqual([
    [
      "apt_0000000000aa",
      { link: "https://meet.example.com/kit-lou", unit: "unit_0000000000aa" },
    ],
  ]);
  const held = plannedOf(
    night,
    arrivals,
    new Map(),
    (id) => id === "apt_000000000011",
    NOW
  );
  expect(held.map((a) => a.id)).toEqual(["apt_000000000011"]);
  // Its own id's night first: a second night of the same start never takes it.
  const two = plannedOf(
    [
      night[0] as Appointment,
      { ...(night[0] as Appointment), id: "apt_0000000000aa" },
    ],
    arrivals,
    new Map(),
    () => true,
    NOW
  );
  expect(two.map((a) => [a.id, "agreed" in a && Boolean(a.agreed)])).toEqual([
    ["apt_000000000011", false],
    ["apt_0000000000aa", true],
  ]);
  // Past the arrival's window, its event's mark keeps it agreed, link and all.
  const [kept = night[0] as Appointment] = plannedOf(
    night,
    [],
    new Map([["apt_000000000011", { link: "https://meet.example.com/x" }]]),
    () => true,
    NOW
  );
  const draft = appointmentDraft(kept, false);
  expect(draft.text).toContain("Meeting link: https://meet.example.com/x");
  expect(draft.hash).not.toBe(
    appointmentDraft(night[0] as Appointment, false).hash
  );
  // A whole day: the same day in another zone is another meeting, never joined.
  const day = { allDay: true, end: "2031-06-01", start: "2031-06-01" };
  const apart = plannedOf(
    [appointment({ ...day, id: "apt_000000000012", zone: "Asia/Tokyo" })],
    [
      {
        ...arrival("apt_0000000000cc", "", ""),
        ...day,
        zone: "America/New_York",
      },
    ],
    new Map(),
    () => false,
    NOW
  );
  expect(apart.map((a) => a.id)).toEqual([
    "apt_000000000012",
    "apt_0000000000cc",
  ]);
});

test("with no night file yet, no event Life wrote is removed", async () => {
  events.set("ev1", {
    allDay: false,
    props: { lifeAppointment: "apt_000000000011", lifeOutput: "appointments" },
  });
  await syncAppointments(NOW);
  expect([...events.keys()]).toEqual(["ev1"]);
});

test("the night's reading of an arrival's meeting keeps its event, busy, with its link and source; a later reply of its start keeps its id", async () => {
  agreed("2031-06-01 10:00", ["whatsapp|m1"]);
  await syncAppointments(NOW);
  const [event, first] = [...events][0] ?? [];
  const writeNight = (nightId: string) =>
    Bun.write(
      APPOINTMENTS,
      JSON.stringify({
        appointments: [
          appointment({
            end: "2031-06-01 11:00",
            id: nightId,
            start: "2031-06-01 10:00",
          }),
        ],
        built: ARRIVAL_AT,
        inputs: "i",
        madeBy: { model: "m", prompt: "p", run: "r" },
        schemaVersion: 1,
      })
    );
  await writeNight("apt_000000000011");
  await syncAppointments(NOW);
  expect([...events.keys()]).toEqual([event ?? ""]);
  // Its sheet shows what the calendar holds: the night's reading, under the arrival's id.
  expect(
    await readAppointmentSheet(
      { appointment: first?.props.lifeAppointment ?? "" },
      noReads,
      NOW
    )
  ).toMatchObject({
    link: "https://meet.example.com/kit-lou",
    title: "Session at the clinic",
  });
  expect(updates.at(-1)).toMatchObject({ busy: true, id: event });
  expect(updates.at(-1)?.description).toContain(
    "Meeting link: https://meet.example.com/kit-lou"
  );
  expect(updates.at(-1)?.description).toContain("Agreed in unit_0000000000aa");
  // The night's next reading takes the arrival's id (`arrivalOf`); past the reply's window the event stays, busy.
  const id = first?.props.lifeAppointment ?? "";
  await writeNight(id);
  const later = new Date("2031-04-15T09:00:00Z");
  await syncAppointments(later);
  expect([...events.keys()]).toEqual([event ?? ""]);
  expect(updates.at(-1)).toMatchObject({ busy: true, id: event });
  // Its sheet, by its push's id, past the reply's window: the night's reading with the arrival's link, as written.
  const sheet = await readAppointmentSheet(
    { pushId: push.pushIdOf(id) },
    noReads,
    later
  );
  expect(sheet).toMatchObject({
    addedAt: NOW.toISOString(),
    appointment: id,
    link: "https://meet.example.com/kit-lou",
  });
  // One never written has no sheet.
  expect(
    await readAppointmentSheet(
      { appointment: "apt_00000000ffff" },
      noReads,
      later
    )
  ).toBeNull();
  // Deleted by him while the first reply is read; then that reply out of the window, a second of the same start in
  // it, the night's reading still there: the same id, never written again.
  events.clear();
  await syncAppointments(NOW);
  agreed("2031-06-01 10:00", ["whatsapp|m5"], LATER_AT);
  await syncAppointments(later);
  await syncAppointments(later);
  expect(events.size).toBe(0);
  expect(
    readAppointmentEvents().byAppointment.get(
      first?.props.lifeAppointment ?? ""
    )?.op
  ).toBe("refused");
  expect(pushed).toHaveBeenCalledTimes(1);
});

const lastOp = (id: string) =>
  readAppointmentEvents().byAppointment.get(id)?.op;

test("his Remove deletes the event and is never written over; his Undo writes it again; a failed delete records nothing", async () => {
  agreed("2031-03-12 10:00", ["whatsapp|m1"]);
  await syncAppointments(NOW);
  const [event, e] = [...events][0] ?? [];
  const id = e?.props.lifeAppointment ?? "";
  failDelete = true;
  const failed = await removeAppointment(id, NOW);
  expect(failed).toMatchObject({ result: "failed" });
  expectWire("change_appointment_failed", failed);
  expect(lastOp(id)).toBe("created");
  failDelete = false;
  // Still listed by Google a moment after his Remove: the sync's delete never writes over his no.
  const listed = new Map(events);
  expect(await removeAppointment(id, NOW)).toEqual({ result: "removed" });
  expect(events.has(event ?? "")).toBe(false);
  events = listed;
  await syncAppointments(NOW);
  await syncAppointments(NOW);
  expect(lastOp(id)).toBe("refused");
  expect([...events.keys()]).toEqual([event ?? ""]);
  // His Undo while Google still lists the event his Remove deleted: written again all the same.
  expect(await restoreAppointment(id, NOW)).toEqual({ result: "restored" });
  expect(lastOp(id)).toBe("created");
  expect(events.size).toBe(2);
  // The next sync, Google still listing the deleted one first: the one his Undo wrote stays.
  const written = readAppointmentEvents().byAppointment.get(id)?.event ?? "";
  await syncAppointments(NOW);
  expect([...events.keys()]).toEqual([written]);
  expect(lastOp(id)).toBe("created");
  expect(pushed).toHaveBeenCalledTimes(1);
});

test("his Remove holds in another calendar; his Undo is its own outcome, whatever fails after it; one he confirmed comes back confirmed", async () => {
  agreed("2031-03-12 10:00", ["whatsapp|m1"]);
  await syncAppointments(NOW);
  const [event, e] = [...events][0] ?? [];
  const id = e?.props.lifeAppointment ?? "";
  // An agent confirmed it with him.
  events.set(event ?? "", {
    ...(e as NonNullable<typeof e>),
    props: { ...e?.props, lifeConfirmed: "yes" },
  });
  expect(await removeAppointment(id, NOW)).toEqual({ result: "removed" });
  setSettings({
    appointmentsCalendar: { account: "a@example.com", calendar: "other" },
  });
  await syncAppointments(NOW);
  await syncAppointments(NOW);
  expect(events.size).toBe(0);
  expect(lastOp(id)).toBe("refused");
  // A second meeting that cannot be written: his Undo still says restored once its own event is written.
  agreed("2031-03-13 10:00", ["whatsapp|m2"]);
  const { create } = fake;
  fake.create = (f, props) =>
    f.summary?.includes("Coffee") && props.lifeAppointment !== id
      ? Promise.reject(new Error("gog calendar create: offline"))
      : create(f, props);
  expect(await restoreAppointment(id, NOW)).toEqual({ result: "restored" });
  fake.create = create;
  expect(lastOp(id)).toBe("created");
  const [back] = [...events.values()];
  expect(back).toMatchObject({ busy: true, props: { lifeConfirmed: "yes" } });
  expect(back?.summary).toBe("Coffee with Kit");
});

test("Undo of one Life no longer holds is refused again; with the calendar off nothing runs", async () => {
  agreed("2031-03-12 10:00", ["whatsapp|m1"]);
  await syncAppointments(NOW);
  const id = [...events.values()][0]?.props.lifeAppointment ?? "";
  await removeAppointment(id, NOW);
  rmSync(readReplyPath(ARRIVAL_AT), { force: true });
  expect(await restoreAppointment(id, NOW)).toMatchObject({
    result: "failed",
  });
  expect(lastOp(id)).toBe("refused");
  setSettings({ appointmentsCalendar: undefined });
  const calls = calendar.mock.calls.length;
  expect(await syncAppointments(NOW)).toBeNull();
  expect(calendar.mock.calls.length).toBe(calls);
});

test("a night-only appointment he confirmed comes back confirmed after his Remove and Undo: its title, busy", async () => {
  await Bun.write(
    APPOINTMENTS,
    JSON.stringify({
      appointments: [
        appointment({ end: "2031-03-12 11:00", start: "2031-03-12 10:00" }),
      ],
      built: ARRIVAL_AT,
      inputs: "i",
      madeBy: { model: "m", prompt: "p", run: "r" },
      schemaVersion: 1,
    })
  );
  await syncAppointments(NOW);
  const [event, e] = [...events][0] ?? [];
  expect(e).toMatchObject({
    busy: false,
    summary: "(Life) Session at the clinic",
  });
  events.set(event ?? "", {
    ...(e as NonNullable<typeof e>),
    props: { ...e?.props, lifeConfirmed: "yes" },
  });
  expect(await removeAppointment("apt_000000000001", NOW)).toEqual({
    result: "removed",
  });
  expect(await restoreAppointment("apt_000000000001", NOW)).toEqual({
    result: "restored",
  });
  const [back] = [...events.values()];
  expect(back).toMatchObject({
    busy: true,
    props: { lifeConfirmed: "yes" },
    summary: "Session at the clinic",
  });
});

test("change_appointment is his token's only; read_appointments finds one by its push's id", async () => {
  agreed("2031-03-12 10:00", ["whatsapp|m1"]);
  await syncAppointments(NOW);
  const id = [...events.values()][0]?.props.lifeAppointment ?? "";
  const call = async (name: string, args: object, over = {}) =>
    (await rpc(await token(over), "tools/call", { arguments: args, name })).json
      .result;
  const byAgent = await call("change_appointment", {
    action: "remove",
    appointment: id,
  });
  expect(byAgent.isError).toBe(true);
  expect(lastOp(id)).toBe("created");
  const read = await call("read_appointments", { pushId: push.pushIdOf(id) });
  expect(JSON.parse(read.content[0].text)).toMatchObject({
    appointment: id,
    link: "https://meet.example.com/kit-lou",
    removedAt: null,
    title: "Coffee with Kit",
  });
  // Its push's id is keyed by this run's secret: the fixture holds a steady one.
  const steadyPush = (text: string) => ({
    ...JSON.parse(text),
    pushId: "0123456789abcdef",
  });
  expectWire("read_appointments", steadyPush(read.content[0].text), true);
  expect(
    (
      await call("read_appointments", {
        appointment: id,
        pushId: "0".repeat(16),
      })
    ).isError
  ).toBe(true);
  const mine = await call(
    "change_appointment",
    { action: "remove", appointment: id },
    { agent: undefined }
  );
  expect(JSON.parse(mine.content[0].text)).toEqual({ result: "removed" });
  expectWire("change_appointment_removed", mine.content[0].text);
  // Removed from the push: its sheet opens as removed.
  const removed = await call("read_appointments", { appointment: id });
  expectWire(
    "read_appointments_removed",
    steadyPush(removed.content[0].text),
    true
  );
});
