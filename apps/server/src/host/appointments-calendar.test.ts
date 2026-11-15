import { expect, test } from "bun:test";
import { appendJsonl } from "../core/files";
import { readAppointmentEvents } from "../memory/appointments";
import { APPOINTMENT_EVENTS } from "../memory/memory-files";
import { type Appointment, AppointmentEvent } from "../records/appointment";
import { appointmentDraft, drafted } from "./appointments-calendar";

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
  expect(refused).toEqual([["obs_000000000001"]]);
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
