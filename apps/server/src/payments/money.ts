import { z } from "zod";
import { execOk } from "../core/proc";
import { Payment, type PaymentsBackend } from "./contract";

// The money backend: his `money` CLI (`money tx --from --to`, JSON), never its database. Only `backend.ts` uses it.
// `money tx` never calls a bank, so a read is local and quick.

export const money: PaymentsBackend = {
  between: async (from, to) => {
    const out = await execOk(["money", "tx", "--from", from, "--to", to]);
    const r = z.array(Payment).safeParse(JSON.parse(out));
    if (!r.success) {
      const [first] = r.error.issues;
      throw new Error(
        `money tx gave another shape (${first?.path.join(".")}: ${first?.message})`
      );
    }
    return r.data;
  },
};
