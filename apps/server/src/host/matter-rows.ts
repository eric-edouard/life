import { blockingCountOf } from "../memory/check-urgency";
import { checksOnMatterOf } from "../memory/checks";
import type { Check } from "../memory/life-checks";
import { needsYouOf } from "../memory/read-matters";

// A matter row as every reader gives it (`read_matters`, `read_matter`, the desk's count, a person's read): the row with
// how many of its open checks block him and whether it needs him, over his open checks read once (`openChecksNow`).

/** Each row with `blockingChecks` (its open checks that block him, `checksOnMatterOf`) and `needsYou` (`needsYouOf`, the one rule). Pure. */
export const matterRowsNowOf = <
  R extends { id: string; nextStep?: { kind: string }; status: string },
>(
  rows: readonly R[],
  open: readonly Pick<Check, "group" | "matter" | "ridesOn" | "subject">[]
) =>
  rows.map((m) => {
    const blockingChecks = blockingCountOf(checksOnMatterOf(open, m.id));
    return { ...m, blockingChecks, needsYou: needsYouOf(m, blockingChecks) };
  });
