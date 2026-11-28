import { isPromptVersion } from "../models/prompt-parts";
import type { DirectionPin } from "../records/matter";
import {
  directionsOf,
  isNewerThan,
  isRunning,
  laterShownOf,
  type MatterRecords,
  type MatterView,
  matterFinderOf,
  OWED_BY_HIM,
  offerEndOf,
} from "./matter-read";

// When Life drafts a matter's direction again (docs/glossary.md: matter direction): the one test, for the night's
// step and the new matter check.

/** The prompt the night drafts directions with: a Life draft of an older one is due again (`isDirectionDue`), so a prompt bump redrafts every running matter. */
export const DIRECTIONS_PROMPT = "memory-matter-directions.v5";

/**
 * Whether Life drafts `v`'s direction: running (or dormant holding an open step he owes, `OWED_BY_HIM`) and grouped,
 * with none yet or a step, a step's ending or an open step's date passing newer than its latest pin, or a latest pin of
 * Life's drafted by an older prompt (`DIRECTIONS_PROMPT`); or, when
 * that pin is Life's, a blind one (no `laterShown`: drafted before it saw later records) or, while `v` is in its offer
 * window (`offerEndOf`), one of its newest later records (`later`, read only then) that the draft was not shown. His own
 * pin is never redrafted over an outside record. Pure.
 */
export const isDirectionDue = (
  v: MatterView,
  latest: DirectionPin | undefined,
  later: () => readonly string[],
  today: string
) => {
  const owesStep = v.openSteps.some((s) => OWED_BY_HIM.includes(s.kind));
  if (v.lone || !(isRunning(v) || (v.open && owesStep))) {
    return false;
  }
  if (
    !(latest && v.goal) ||
    isNewerThan(v, latest, today) ||
    (latest.by === "life" &&
      !isPromptVersion(latest.prompt ?? "", DIRECTIONS_PROMPT))
  ) {
    return true;
  }
  const end = offerEndOf(v);
  const { laterShown } = latest;
  return (
    latest.by === "life" &&
    (!laterShown ||
      Boolean(
        end && today <= end && later().some((id) => !laterShown.includes(id))
      ))
  );
};

/**
 * The test of "which matters of `book` are due a direction" (`isDirectionDue`), by matter id: for the night's step and
 * the new matter check. The later records are read (`laterShownOf`) only for a matter in its offer window whose latest
 * pin is Life's. Pure.
 */
export function directionDueOf(
  book: readonly MatterView[],
  rec: Pick<MatterRecords, "directions" | "observations" | "refOf">,
  today: string
) {
  const directions = directionsOf(matterFinderOf(book), rec.directions);
  const byId = new Map(book.map((v) => [v.id, v]));
  return (id: string) => {
    const v = byId.get(id);
    return (
      v !== undefined &&
      isDirectionDue(
        v,
        directions.get(v)?.latest,
        () => laterShownOf(v, rec.observations, rec.refOf).map((o) => o.id),
        today
      )
    );
  };
}
