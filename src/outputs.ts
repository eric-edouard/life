import { settings } from "./settings";

// What Life does or sends outside its memory (docs/tasks.md, "The only sends"): one entry per output, its switch read
// from settings here and nowhere else. Off, an output does nothing and says so; its own module does the work.
export const OUTPUTS = {
  /** Asks delivered to his agent as MCP events (or pulled, `agent.transport`). */
  agent: { label: "Agent asks", on: () => Boolean(settings().agent) },
  /** The daily restic snapshot (`backup.ts`). */
  backup: { label: "Backup", on: () => Boolean(settings().backup) },
  /** The connector, its OAuth issuer and the pages behind sign-in (`server.ts`). */
  connector: { label: "Connector", on: () => Boolean(settings().connector) },
  /** The moments on a calendar: Google's through `gog`, else an Apple one through the app's EventKit tool (`past.ts`). */
  past: {
    label: "Past calendar",
    on: () => {
      const { past } = settings();
      return Boolean(past && (past.account || process.env.LIFE_EVENTKIT));
    },
  },
  /** His Apple Reminders, acted on at his request (`actions.ts`, `reminders/`): off, nothing touches them. */
  reminders: { label: "Reminders", on: () => settings().reminders },
} satisfies Record<string, { label: string; on: () => boolean }>;

export type Output = keyof typeof OUTPUTS;

/** Whether an output is on. */
export const isOn = (output: Output) => OUTPUTS[output].on();
