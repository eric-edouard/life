import { join } from "node:path";
import { filesIn } from "../core/files";
import type { Correction, Observation } from "../records/observation";
import { PAGE_KINDS, PAGES, readObservationStatusInputs } from "./memory-files";
import { frozenOnlyOf, layoutOf, parsePage } from "./page-format";
import { OWNER } from "./read-truth";

/** Whether some page layout freezes a section now (`layoutOf`): with every add-on on none does. */
const hasFrozen = () =>
  layoutOf(OWNER).frozen.length > 0 || layoutOf("person:x").frozen.length > 0;

/**
 * `readObservationStatusInputs` with the observations only a frozen section cites (`frozenOnlyOf`), read from the page
 * files: the one reading of what decides where an observation stands. With every add-on on, no page file is read.
 */
export async function readStatusInputs(
  corrections: Correction[],
  read?: Promise<Observation[]>
) {
  const inputs = await readObservationStatusInputs(corrections, read);
  if (!hasFrozen()) {
    return inputs;
  }
  const texts = await Promise.all(
    PAGE_KINDS.map(async (kind) =>
      Promise.all(
        (await filesIn(join(PAGES, kind), ".md")).map((n) =>
          Bun.file(join(PAGES, kind, n)).text()
        )
      )
    )
  );
  const pages = texts.flat().flatMap((t) => parsePage(t) ?? []);
  return { ...inputs, frozenOnly: frozenOnlyOf(pages) };
}
