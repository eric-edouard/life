import { blockingCountOf } from "../memory/check-urgency";
import { checksOnMatterOf } from "../memory/checks";
import type { Check } from "../memory/life-checks";
import { iconPicksSettled, readLifeIcons } from "../memory/matter-icons";
import { needsYouOf, openMatters } from "../memory/read-matters";
import { readPerson } from "../personal/person-parts";
import { openChecksAndKeyNow, versionOf } from "./inbox";

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

async function readRows(
  q: Parameters<typeof openMatters>[0],
  agentOf: Parameters<typeof openMatters>[1],
  open: Parameters<typeof matterRowsNowOf>[1]
) {
  const { matters, project } = await openMatters(q, agentOf, readLifeIcons);
  return { matters: matterRowsNowOf(matters, open), project };
}

/** The rows read for the checks' key `keptFor`, by the rest of their key (the query, the agents, the icons). */
let kept:
  | { keptFor: string; rows: Map<string, ReturnType<typeof readRows>> }
  | undefined;

/**
 * The running matters as rows now (`openMatters`, of one person, project or area when given), over his open checks read
 * once; each with Life's icon (`readLifeIcons`, never waited on) and `agentOf`'s agent: `read_matters` and a person's
 * read alike. Of one project, its page's head too (`project`). Read again only when its key changed: the checks' key
 * (`checksNow`: it covers the matter book's files and his day), the query, the agents' stamp and the icon picks settled
 * (`iconPicksSettled`); `version` is that key's (`versionOf`).
 */
export async function readMatterRowsNow(
  q: Parameters<typeof openMatters>[0] = {},
  agentOf?: NonNullable<Parameters<typeof openMatters>[1]> & { stamp: string }
) {
  const { checks: open, key } = await openChecksAndKeyNow();
  const rest = JSON.stringify([q, agentOf?.stamp ?? null, iconPicksSettled()]);
  if (kept?.keptFor !== key) {
    kept = { keptFor: key, rows: new Map() };
  }
  const { rows } = kept;
  let read = rows.get(rest);
  if (!read) {
    read = readRows(q, agentOf, open);
    rows.set(rest, read);
    read.catch(() => rows.delete(rest));
  }
  return { ...(await read), version: versionOf(JSON.stringify([key, rest])) };
}

/** `read_people_and_organizations` and `bun life memory person`: the person read (`readPerson`) with the matter rows read now. */
export const readPeopleAndOrganizations = (
  name?: string,
  o: Parameters<typeof readPerson>[1] = {}
) => readPerson(name, o, async () => (await readMatterRowsNow()).matters);
