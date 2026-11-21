import { isOn } from "../core/outputs";
import { settings } from "../core/settings";
import { DESCRIPTION_MAX, mapLinksOf } from "../memory/calendar-events";
import type { AddEventByHisWord } from "../memory/decision-add";
import { eventOf } from "../memory/needs";
import { clip } from "../memory/units";
import { googleCalendar } from "./google-calendar";

// An agent's event on his yes (his word of 21 Nov 2026): a card's `event` need written once into the `appointments`
// setting's calendar, with its popup reminders (never mail, never guests, nothing sent), marked `lifeOutput=card` so
// neither the appointments' sync nor the Past calendar ever touches it again: an event he deletes stays deleted.

/** Writes the card's event on his answer; returns its Google id, throws when it could not (recorded as `added`'s error, never retried). */
export const addEventByHisWord: AddEventByHisWord = async (d) => {
  const { appointmentsCalendar: s } = settings();
  const event = eventOf(d.needs);
  if (!(s && isOn("appointmentsCalendar"))) {
    throw new Error("the calendar is off in his settings");
  }
  if (!event) {
    throw new Error("the card holds no event");
  }
  return await googleCalendar(s.calendar, s.account).create(
    {
      allDay: false,
      busy: true,
      description: clip(
        [
          "Added by Life on your yes to an agent's card.",
          ...(event.place ? mapLinksOf({ name: event.place }) : []),
          `Card ${d.id}.`,
        ].join("\n"),
        DESCRIPTION_MAX
      ),
      from: event.start,
      location: event.place ?? null,
      reminders: event.reminders.map((m) => `popup:${m}m`),
      summary: event.title,
      to: event.end,
    },
    { lifeCard: d.id, lifeOutput: "card" }
  );
};
