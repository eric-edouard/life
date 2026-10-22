import { settings } from "./settings";

// The outputs Life can turn on or off (docs/tasks.md, "The only sends"), one entry each: what he calls it and its
// switch, read from settings here. Off, an output does nothing and says so (`off`); its own module does the work and
// reads the rest of its settings.
export const OUTPUTS = {
  /** The daily restic snapshot (`backup.ts`). */
  backup: { label: "Backup", on: () => Boolean(settings().backup) },
  /** The connector, its OAuth issuer and the pages behind sign-in (`server.ts`). */
  connector: { label: "Connector", on: () => Boolean(settings().connector) },
  /** The moments on a calendar (`past.ts`). */
  past: { label: "Past calendar", on: () => Boolean(settings().past) },
  /** His Apple Reminders, acted on at his request (`actions.ts`, `reminders/`): off, nothing touches them. */
  reminders: { label: "Reminders", on: () => settings().reminders },
} satisfies Record<string, { label: string; on: () => boolean }>;

export type Output = keyof typeof OUTPUTS;

export const isOn = (output: Output) => OUTPUTS[output].on();

/** Why an output does nothing now, when it is off. */
export const off = (output: Output) =>
  isOn(output)
    ? undefined
    : `${OUTPUTS[output].label} is off (settings: ${output})`;
