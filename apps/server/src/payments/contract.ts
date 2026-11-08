import { z } from "zod";

// The payments contract: what a payment is to Life (`Payment`) and where it comes from (`PaymentsBackend`). Money is
// the backend's to decide (whose money, what counts, the category); Life only places a payment in his day.
// `backend.ts` picks this install's one.

/** A payment as every backend gives it: signed (negative is money out), money in included. */
export const Payment = z.object({
  amount: z.number(),
  category: z.string().nullable(),
  currency: z.string(),
  /** Its booking day (YYYY-MM-DD), when no time is known. */
  date: z.iso.date(),
  /** The amount in EUR, at the backend's rate. */
  eur: z.number(),
  id: z.string(),
  merchant: z.string(),
  /** When it was paid (an instant with its offset), or null when the bank gives only the day. */
  paidAt: z.iso.datetime({ offset: true }).nullable(),
  /** Whether it counts in his spending (the backend's rule): not income, not money held for someone else. */
  spending: z.boolean(),
});
export type Payment = z.infer<typeof Payment>;

export interface PaymentsBackend {
  /** The payments booked from `from` to `to` (YYYY-MM-DD, both included). */
  between: (from: string, to: string) => Promise<Payment[]>;
}
