import {
  blockingCountOf,
  type HOW_ASKED,
  isInboxCheck,
} from "../memory/check-urgency";
import { checksOnMatterOf } from "../memory/checks";
import type { Check } from "../memory/life-checks";
import { needsYouOf, openMatters } from "../memory/read-matters";
import { readPerson } from "../personal/person-parts";
import { openChecksAndKeyNow, versionOf } from "./inbox";

// A matter row as every reader gives it (`read_matters`, `read_matter`, the desk's count, a person's read): the row with
// how many of its open checks block him and whether it needs him, over his open checks read once (`openChecksNow`).

/** Each row with `blockingChecks` (its inbox's checks that block him, `checksOnMatterOf`) and `needsYou` (`needsYouOf`, the one rule): a check on its page only (`isInboxCheck`) counts in neither. Pure. */
export const matterRowsNowOf = <
  R extends { id: string; nextStep?: { kind: string }; status: string },
>(
  rows: readonly R[],
  open: readonly Pick<
    Check,
    "deadline" | "group" | typeof HOW_ASKED | "matter" | "ridesOn" | "subject"
  >[]
) =>
  rows.map((m) => {
    const on = checksOnMatterOf(open.filter(isInboxCheck), m.id);
    const blockingChecks = blockingCountOf(on);
    const isYourMove = on.some((c) => c.group === "your move");
    return {
      ...m,
      blockingChecks,
      needsYou: needsYouOf(m, blockingChecks, isYourMove),
    };
  });

async function readRows(
  q: Parameters<typeof openMatters>[0],
  agentOf: Parameters<typeof openMatters>[1],
  open: Parameters<typeof matterRowsNowOf>[1]
) {
  const { matters, nextBefore, project } = await openMatters(q, agentOf);
  const answer = {
    matters: matterRowsNowOf(matters, open),
    nextBefore,
    project,
  };
  return { ...answer, version: versionOf(JSON.stringify(answer)) };
}

/** The rows read for `keptFor` (the checks' key: its moving drops them all), by the query and the agents. */
let kept:
  | { keptFor: string; rows: Map<string, ReturnType<typeof readRows>> }
  | undefined;

/**
 * The matters as rows now (`openMatters`: running, or open or closed as asked, of one person, project or area when given), over his open checks read
 * once; each with its icon (`iconNow`) and `agentOf`'s agent: `read_matters` and a person's
 * read alike. Of one project, its page's head too (`project`). Read again only when its key changed: the checks' key
 * (`checksAndKeyNow`: it covers the matter book's files and his day), the query, and the agents' stamp. `version` is the answer's own digest
 * (`versionOf`): two processes giving the same version give the same rows.
 */
export const readMatterRowsNow = async (
  ...args: Parameters<typeof readRowsAndChecksNow>
) => (await readRowsAndChecksNow(...args)).rows;

/** The matter rows (`readMatterRowsNow`) and the open checks they were read over, one read of each. */
async function readRowsAndChecksNow(
  q: Parameters<typeof openMatters>[0] = {},
  agentOf?: NonNullable<Parameters<typeof openMatters>[1]> & { stamp: string }
) {
  const { checks: open, key } = await openChecksAndKeyNow();
  const keptFor = key;
  const rest = JSON.stringify([q, agentOf?.stamp ?? null]);
  if (kept?.keptFor !== keptFor) {
    kept = { keptFor, rows: new Map() };
  }
  const { rows } = kept;
  let read = rows.get(rest);
  if (!read) {
    read = readRows(q, agentOf, open);
    rows.set(rest, read);
    read.catch(() => rows.delete(rest));
  }
  return { checks: open, rows: await read };
}

/** `read_people_and_organizations` and `bun life memory person`: the person read (`readPerson`) with the matter rows and his open checks read now (the same list `read_inbox` reads). */
export const readPeopleAndOrganizations = (
  name?: string,
  o: Parameters<typeof readPerson>[1] = {}
) =>
  readPerson(name, o, async () => {
    const { checks, rows } = await readRowsAndChecksNow();
    return { checks, matters: rows.matters };
  });
