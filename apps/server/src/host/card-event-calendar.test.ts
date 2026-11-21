import { afterEach, expect, spyOn, test } from "bun:test";
import { setSettings, settings } from "../core/settings";
import type { Decision } from "../memory/decision-lines";
import { addEventByHisWord } from "./card-event-calendar";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as google from "./google-calendar";

const before = settings();
afterEach(() => setSettings(before));
const card = {
  id: "dec_000000000001",
  needs: [
    {
      end: "2026-12-01T12:00:00+07:00",
      kind: "event",
      place: "Blue Reef",
      reminders: [60, 1440],
      start: "2026-12-01T08:00:00+07:00",
      title: "Dive course",
    },
  ],
} as unknown as Omit<Decision, "state">;

test("the card's event is written once as Life's own card event: busy, popup reminders only, no guests, never the appointments' mark", async () => {
  setSettings({
    ...before,
    appointmentsCalendar: { account: "me@example.com", calendar: "primary" },
  });
  const create = spyOn(google, "googleCalendar").mockReturnValue({
    create: () => Promise.resolve("gcal-1"),
  } as never);
  expect(await addEventByHisWord(card)).toBe("gcal-1");
  expect(create).toHaveBeenCalledWith("primary", "me@example.com");
  create.mockRestore();
  const made = spyOn(google, "googleCalendar");
  made.mockReturnValue({
    create: (f: unknown, props: unknown) => {
      expect(f).toMatchObject({
        busy: true,
        reminders: ["popup:60m", "popup:1440m"],
        summary: "Dive course",
      });
      expect(props).toEqual({ lifeCard: card.id, lifeOutput: "card" });
      return Promise.resolve("gcal-2");
    },
  } as never);
  expect(await addEventByHisWord(card)).toBe("gcal-2");
  made.mockRestore();
});

test("with the calendar off in his settings, nothing is written and the error says so", async () => {
  setSettings({ ...before, appointmentsCalendar: undefined });
  await expect(addEventByHisWord(card)).rejects.toThrow("calendar is off");
});
