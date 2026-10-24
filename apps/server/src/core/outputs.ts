import { settings } from "./settings";

// The outputs Life can turn on or off (docs/tasks.md, "The only sends"), one entry each: what he calls it and its
// switch, read from settings here. Off, an output does nothing and says so (`off`); its own module does the work and
// reads the rest of its settings.
export const OUTPUTS = {
  /** His agent, handed his asks as ledger events (`host/events.ts`): off, nothing is meant to receive them. */
  agent: { label: "Agent", on: () => Boolean(settings().agent) },
  /** The daily restic snapshot (`backup.ts`). */
  backup: { label: "Backup", on: () => Boolean(settings().backup) },
  /** The connector, its OAuth issuer and the pages behind sign-in (`server.ts`). */
  connector: { label: "Connector", on: () => Boolean(settings().connector) },
  /** The moments on a calendar: Google's through `gog` with an account, else an Apple one through the app's EventKit tool (`host/past-calendar.ts`). */
  past: {
    label: "Past calendar",
    on: () => {
      const { past } = settings();
      return Boolean(past && (past.account || process.env.LIFE_EVENTKIT));
    },
  },
  /** His to-do list, one backend (Reminders or Google Tasks), acted on at his request (`apps/server/src/todo-list/`): off, nothing touches it. */
  todo_list: { label: "To-do list", on: () => Boolean(settings().todo_list) },
} satisfies Record<string, { label: string; on: () => boolean }>;

type Output = keyof typeof OUTPUTS;

export const isOn = (output: Output) => OUTPUTS[output].on();

/** Why an output does nothing now, when it is off. */
export const off = (output: Output) =>
  isOn(output)
    ? undefined
    : `${OUTPUTS[output].label} is off (settings: ${output})`;
