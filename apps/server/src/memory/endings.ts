import { readAppended } from "../core/files";
import { settings } from "../core/settings";
import { type Link, LinkBatch } from "../records/link";
import {
  LINKS,
  readCorrections,
  readFactCheckAnswers,
  readFactChecks,
} from "./memory-files";

// What the links found, and what he said of it: the one place readers learn of links. A link never deletes and never
// closes a matter by itself: its ending is "maybe done" (the matter stays open) until his word, a fact-check answer to
// the question `askEndings` put (`fact-checks.ts`): right makes it his word, wrong removes that link for good.

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

/** A fact check that asks whether an open thing ended: it names the later step (`later`); every other one is a doubt. */
export const isEndingAsk = (s: { later?: string }) => s.later !== undefined;

/**
 * Every ending (`endingsOf`, wrong ones removed) given which records are current, and the open things he said are
 * done (`confirmed`: he answered right to the ask about that very pair). Independent of his `endings` setting.
 */
export function endingsNow(isCurrent: (id: string) => boolean) {
  const answers = readFactCheckAnswers();
  const asks = readFactChecks().filter(isEndingAsk);
  const said = (ref: string) => answers.get(ref)?.answer;
  const refused = new Set(
    asks
      .filter((s) => said(s.ref) === "false")
      .map((s) => `${s.ref} ${s.later}`)
  );
  const endings = endingsOf(readBatches(), isCurrent, refused);
  const confirmed = new Set(
    asks
      .filter(
        (s) => said(s.ref) === "true" && endings.get(s.ref)?.later === s.later
      )
      .map((s) => s.ref)
  );
  return { confirmed, endings };
}

/**
 * What the readers learn of links (`read_matters`, `read_matter`, `read_day`, a person's page): `confirmed` ends a
 * step; `maybe` (found, not his word yet) only shows "maybe done" and ends nothing. Both empty while his `endings`
 * setting is off.
 */
export function endingsRead(isCurrent: (id: string) => boolean) {
  if (!settings().endings) {
    return { confirmed: new Set<string>(), maybe: new Map<string, Ending>() };
  }
  const { confirmed, endings } = endingsNow(isCurrent);
  return {
    confirmed,
    maybe: new Map([...endings].filter(([ref]) => !confirmed.has(ref))),
  };
}

/** The spec's two marks are read over this many of each. */
const SAMPLE = 50;

/**
 * The two marks of the spec before a link may close a matter alone, from his word: of the last 50 endings he judged,
 * none was wrong (`liveClosed`: a live thing a link would have closed); of the last 50 open things he said are done
 * (an `outdated` correction) that a link had judged, at most 2 had no ending found (`staleOpen`: a stale thing a link
 * left open). `pass` needs both samples full.
 */
export function endingMarks() {
  const answers = readFactCheckAnswers();
  const judged = readFactChecks()
    .filter(isEndingAsk)
    .filter((s) => ["true", "false"].includes(answers.get(s.ref)?.answer ?? ""))
    .slice(-SAMPLE);
  const batches = readBatches();
  const shown = new Set(batches.flatMap((b) => b.open));
  const found = endingsOf(batches, () => true);
  const said = readCorrections()
    .filter((c) => c.kind === "outdated")
    .flatMap((c) => c.observations)
    .filter((id) => shown.has(id))
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
