import { settings } from "../core/settings";
import type { PaymentsBackend } from "./contract";
import { money } from "./money";

// This install's payments backend, from the `payments` setting: off (the default), Life shows no payment.

/** The backend, or undefined while payments are off. */
export const payments = (): PaymentsBackend | undefined =>
  settings().payments?.backend === "money" ? money : undefined;
