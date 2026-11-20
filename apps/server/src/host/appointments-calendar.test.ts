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
import { READS, storeReply } from "../memory/read-replies";
import { type Appointment, AppointmentEvent } from "../records/appointment";
import type { ReadReply } from "../records/read-reply";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as push from "../sources/lifelog-push";
import {
  appointmentDraft,
  drafted,
  plannedOf,
  syncAppointments,
} from "./appointments-calendar";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as google from "./google-calendar";

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
let events: Map<
  string,
  { allDay: boolean; busy?: boolean; props: Record<string, string> }
>;
const fake = {
  create: (
    f: { allDay: boolean; busy: boolean },
    props: Record<string, string>
  ) => {
    const id = `ev${events.size + 1}`;
    events.set(id, { allDay: f.allDay, busy: f.busy, props });
    return Promise.resolve(id);
  },
  exists: (id: string) => Promise.resolve(events.has(id)),
  list: () =>
    Promise.resolve(
      [...events].map(([id, e]) => ({ allDay: e.allDay, id, props: e.props }))
    ),
  remove: (id: string) => {
    events.delete(id);
    return Promise.resolve();
  },
  update: () => Promise.resolve(),
};
const was = settings().appointmentsCalendar;
const nightFile = existsSync(APPOINTMENTS)
  ? readFileSync(APPOINTMENTS, "utf8")
  : null;
let calendar: ReturnType<typeof spyOn<typeof google, "googleCalendar">>;
let pushed: ReturnType<typeof spyOn<typeof push, "notifyPhone">>;
const agreed = (start: string, messages: string[]) =>
  storeReply(
    {
      at: ARRIVAL_AT,
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
    ARRIVAL_AT
  );
const clean = () => {
  rmSync(APPOINTMENT_EVENTS, { force: true });
  rmSync(readReplyPath(ARRIVAL_AT), { force: true });
  rmSync(APPOINTMENTS, { force: true });
};
beforeEach(() => {
  clean();
  events = new Map();
  setSettings({
    appointmentsCalendar: { account: "a@example.com", calendar: "cal" },
  });
  calendar = spyOn(google, "googleCalendar").mockReturnValue(
    fake as unknown as google.GoogleCalendar
  );
  pushed = spyOn(push, "notifyPhone").mockResolvedValue(undefined);
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
    }),
  ];
  const arrivals = [
    arrival("apt_0000000000aa", "2031-03-12 10:00", "2031-03-12 11:00"),
    // Ended at 08:00 today, read late: never written.
    arrival("apt_0000000000bb", "2031-03-10 07:00", "2031-03-10 08:00"),
  ];
  const fresh = plannedOf(night, arrivals, new Map(), () => false, NOW);
  expect(fresh.map((a) => [a.id, "agreed" in a && a.agreed])).toEqual([
    ["apt_0000000000aa", { link: "https://meet.example.com/kit-lou" }],
  ]);
  const held = plannedOf(
    night,
    arrivals,
    new Map(),
    (id) => id === "apt_000000000011",
    NOW
  );
  expect(held.map((a) => a.id)).toEqual(["apt_000000000011"]);
  // Past the arrival's window, its event's mark keeps it agreed, link and all.
  const later = plannedOf(
    night,
    [],
    new Map([["apt_000000000011", { link: "https://meet.example.com/x" }]]),
    () => true,
    NOW
  );
  const [agreed] = later;
  expect(agreed && appointmentDraft(agreed, false).text).toContain(
    "Meeting link: https://meet.example.com/x"
  );
  expect(appointmentDraft(night[0] as Appointment, false).hash).not.toBe(
    agreed && appointmentDraft(agreed, false).hash
  );
});

test("with no night file yet, no event Life wrote is removed", async () => {
  events.set("ev1", {
    allDay: false,
    props: { lifeAppointment: "apt_000000000011", lifeOutput: "appointments" },
  });
  await syncAppointments(NOW);
  expect([...events.keys()]).toEqual(["ev1"]);
});
