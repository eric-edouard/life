import { readAppended } from "../core/files";
import { settings } from "../core/settings";
import { isEndingCheck } from "../records/fact-check";
import { type Link, LinkBatch } from "../records/link";
import { LINKS, readFactCheckAnswers, readFactChecks } from "./memory-files";

// What the links found, and what he said of it: the one place readers learn of links. A link never deletes: it ends
// its step "probably" at once (a matter it closes reads probably done), and is an ending check `checksNow` lists until
// his word (`fact-checks.ts` writes it with his answer): right is his `outdated` word (`answeredFactCheckCorrections`),
// wrong removes that link for good and the step is open again.

export type Ending = Link & { at: string };

export const readBatches = () =>
  readAppended(
    LINKS,
    LinkBatch,
    (last?: LinkBatch[]) => [...(last ?? [])],
    (all, b) => {
      all.push(b);
    }
  );

/**
 * What each open thing is ended by: its first link, in the order judged, whose two ends are both current (`isCurrent`:
 * an end re-read away counts for nothing, as a replacement re-read away retires nothing; the pair is judged again
 * under its new ids) and that he did not call wrong (`refused`: "<earlier> <later>"). The one place that decides what
 * a link ends.
 */
export function endingsOf(
  batches: LinkBatch[],
  isCurrent: (id: string) => boolean,
  refused: ReadonlySet<string> = new Set()
) {
  const endings = new Map<string, Ending>();
  for (const b of batches) {
    for (const l of b.links) {
      if (
        !endings.has(l.earlier) &&
        isCurrent(l.earlier) &&
        isCurrent(l.later) &&
        !refused.has(`${l.earlier} ${l.later}`)
      ) {
        endings.set(l.earlier, { ...l, at: b.at });
      }
    }
  }
  return endings;
}

/**
 * Every ending (`endingsOf`, wrong ones removed) given which records are current, and the open steps he called wrong
 * (`refused`: a link is not shown for them again). Independent of his `endings` setting. His right is not here: it is
 * an `outdated` correction, which retires the step (`readCorrections`).
 */
export function endingsNow(isCurrent: (id: string) => boolean) {
  const answers = readFactCheckAnswers();
  const wrong = readFactChecks().filter(
    (s) => isEndingCheck(s) && answers.get(s.ref)?.answer === "false"
  );
  const pairs = new Set(wrong.map((s) => `${s.ref} ${s.endedBy}`));
  return {
    endings: endingsOf(readBatches(), isCurrent, pairs),
    refused: new Set(wrong.map((s) => s.ref)),
  };
}

/**
 * What the readers learn of links (`read_matters`, `read_matter`, `read_day`, a person's page, the checks): each step a
 * link ends, not his word yet, which then reads probably ended. Once he called a step's ending wrong, no further one
 * ends it (a stopgap). Empty while his `endings` setting is off.
 */
export function endingsRead(isCurrent: (id: string) => boolean) {
  if (!settings().endings) {
    return { linkEndings: new Map<string, Ending>() };
  }
  const { endings, refused } = endingsNow(isCurrent);
  return {
    linkEndings: new Map([...endings].filter(([ref]) => !refused.has(ref))),
  };
}
