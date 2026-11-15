import { readAppended } from "../core/files";
import { settings } from "../core/settings";
import { isEndingCheck } from "../records/fact-check";
import { type Link, LinkBatch } from "../records/link";
import {
  LINKS,
  readCorrections,
  readFactCheckAnswers,
  readFactChecks,
} from "./memory-files";

// What the links found, and what he said of it: the one place readers learn of links. A link never deletes and never
// closes a matter by itself: its ending is "maybe done" (the matter stays open) until his word, a fact-check answer to
// the ending check `checksNow` lists (`fact-checks.ts` writes it with his answer): right is his `outdated` word (`answeredFactCheckCorrections`), wrong removes that link for good.

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
 * What the readers learn of links (`read_matters`, `read_matter`, `read_day`, a person's page): `maybe` (found, not his
 * word yet) only shows "maybe done" and ends nothing. Once he called a step's ending wrong, no further one is shown
 * for it (a stopgap). Empty while his `endings` setting is off.
 */
export function endingsRead(isCurrent: (id: string) => boolean) {
  if (!settings().endings) {
    return { maybe: new Map<string, Ending>() };
  }
  const { endings, refused } = endingsNow(isCurrent);
  return {
    maybe: new Map([...endings].filter(([ref]) => !refused.has(ref))),
  };
}

/** Each mark is read over this many. */
const SAMPLE = 50;

/**
 * The marks before a link may close a matter alone, from his word. Closed side: of the last 50 endings he judged,
 * none wrong (`liveClosed`: a live thing a link would have closed). Open side, a stand-in for the spec's open-side
 * mark until he checks open items: of the last 50 things he said were done on his own (an `outdated` correction, not
 * his answer to an ending check) that a link had judged, at most 2 had no ending found (`staleOpen`). `pass` needs both
 * samples full.
 */
export function endingMarks() {
  const answers = readFactCheckAnswers();
  const judged = readFactChecks()
    .filter(isEndingCheck)
    .filter((s) => ["true", "false"].includes(answers.get(s.ref)?.answer ?? ""))
    .slice(-SAMPLE);
  const batches = readBatches();
  const shown = new Set(batches.flatMap((b) => b.open));
  const found = endingsOf(batches, () => true);
  const checked = new Set(
    readFactChecks()
      .filter(isEndingCheck)
      .map((s) => s.ref)
  );
  const said = readCorrections()
    .filter((c) => c.kind === "outdated")
    .flatMap((c) => c.observations)
    .filter((id) => shown.has(id) && !checked.has(id))
    .slice(-SAMPLE);
  const liveClosed = judged.filter(
    (s) => answers.get(s.ref)?.answer === "false"
  ).length;
  const staleOpen = said.filter((id) => !found.has(id)).length;
  return {
    closed: judged.length,
    liveClosed,
    open: said.length,
    pass:
      judged.length === SAMPLE &&
      said.length === SAMPLE &&
      liveClosed === 0 &&
      staleOpen <= 2,
    staleOpen,
  };
}
