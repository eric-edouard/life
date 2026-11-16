import { join } from "node:path";
import { filesIn } from "../core/files";
import type { Correction, Observation } from "../records/observation";
import { PAGE_KINDS, PAGES, readObservationStatusInputs } from "./memory-files";
import { frozenOnlyOf, layoutOf, type Parsed, parsePage } from "./page-format";
import { OWNER } from "./read-truth";

/** Whether some page layout freezes a section now (`layoutOf`): with every add-on on none does. */
const hasFrozen = () =>
  layoutOf(OWNER).frozen.length > 0 || layoutOf("person:x").frozen.length > 0;

/** Every page file on disk, parsed. */
export async function readParsedPages() {
  const texts = await Promise.all(
    PAGE_KINDS.map(async (kind) =>
      Promise.all(
        (await filesIn(join(PAGES, kind), ".md")).map((n) =>
          Bun.file(join(PAGES, kind, n)).text()
        )
      )
    )
  );
  return texts.flat().flatMap((t) => parsePage(t) ?? []);
}

/**
 * `readObservationStatusInputs` with the observations only a frozen section cites (`frozenOnlyOf`): what readers hide
 * (`readerShows`). `pages`: the parsed pages when the caller holds them; with every add-on on, none is read.
 */
export async function readStatusInputs(
  corrections: Correction[],
  read?: Promise<Observation[]>,
  pages?: Parsed[]
) {
  const inputs = await readObservationStatusInputs(corrections, read);
  if (!(pages || hasFrozen())) {
    return inputs;
  }
  return {
    ...inputs,
    frozenOnly: frozenOnlyOf(pages ?? (await readParsedPages())),
  };
}
