import { settings } from "./settings";

// The outputs Life can turn on or off (docs/tasks.md), one entry each: what he calls it and its
// switch, read from settings here. Off, an output does nothing and says so (`off`); its own module does the work and
// reads the rest of its settings.
export const OUTPUTS = {
  /** The appointments in his calendar, unconfirmed until an agent confirms them with him (`host/appointments-calendar.ts`). */
  appointmentsCalendar: {
    label: "Appointments",
    on: () => Boolean(settings().appointmentsCalendar),
  },
  /** The daily restic snapshot (`backup.ts`). */
  backup: { label: "Backup", on: () => Boolean(settings().backup) },
  /** The connector and its OAuth issuer (`server.ts`). */
  connector: { label: "Connector", on: () => Boolean(settings().connector) },
  /** The episodes on a calendar: Google's through `gog` with an account, else an Apple one through the app's EventKit tool (`host/past-calendar.ts`). */
  pastCalendar: {
    label: "Past calendar",
    on: () => {
      const { pastCalendar } = settings();
      return Boolean(
        pastCalendar && (pastCalendar.account || process.env.LIFE_EVENTKIT)
      );
    },
  },
  /** His to-do list, one backend (Reminders or Google Tasks), acted on at his request (`apps/server/src/todo-list/`): off, nothing touches it. */
  todoList: { label: "To-do list", on: () => Boolean(settings().todoList) },
} satisfies Record<string, { label: string; on: () => boolean }>;

type Output = keyof typeof OUTPUTS;

export const isOn = (output: Output) => OUTPUTS[output].on();

/** Why an output does nothing now, when it is off. */
export const off = (output: Output) =>
  isOn(output)
    ? undefined
    : `${OUTPUTS[output].label} is off (settings: ${output})`;
