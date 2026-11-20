import { blockingCountOf } from "../memory/check-urgency";
import { checksOnMatterOf } from "../memory/checks";
import type { Check } from "../memory/life-checks";
import { readLifeIcons } from "../memory/matter-icons";
import { needsYouOf, openMatters } from "../memory/read-matters";
import { readPerson } from "../personal/person-parts";
import { openChecksNow } from "./inbox";

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

/**
 * The running matters as rows now (`openMatters`, of one person, project or area when given), over his open checks read
 * once; each with Life's icon (`readLifeIcons`) and `agentOf`'s agent: `read_matters` and a person's read alike. Of one
 * project, its page's head too (`project`).
 */
export async function readMatterRowsNow(
  q: Parameters<typeof openMatters>[0] = {},
  agentOf?: Parameters<typeof openMatters>[1]
) {
  const [{ matters, project }, open] = await Promise.all([
    openMatters(q, agentOf, readLifeIcons),
    openChecksNow(),
  ]);
  return { matters: matterRowsNowOf(matters, open), project };
}

/** `read_people_and_organizations` and `bun life memory person`: the person read (`readPerson`) with the matter rows read now. */
export const readPeopleAndOrganizations = (
  name?: string,
  o: Parameters<typeof readPerson>[1] = {}
) => readPerson(name, o, async () => (await readMatterRowsNow()).matters);
