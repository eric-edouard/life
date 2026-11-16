import { join } from "node:path";
import { filesIn } from "../core/files";
import type { Correction, Observation } from "../records/observation";
import {
  type ObservationStatusInputs,
  PAGE_KINDS,
  PAGES,
  readObservationStatusInputs,
} from "./memory-files";
import { frozenOnlyOf, layoutOf, type Parsed, parsePage } from "./page-format";
import { OWNER } from "./read-truth";

/** Whether some page layout freezes a section now (`layoutOf`): with every add-on on none does. */
export const hasFrozen = () =>
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
 * `statusInputs` with the observations only a frozen section cites (`frozenOnlyOf`), for a reader to hide
 * (`isCitedOnlyByFrozen`); the steps that compute never ask. `pages`: the parsed pages when the caller holds them; with
 * every add-on on, no page is read or scanned.
 */
export async function forReaders(
  statusInputs: ObservationStatusInputs,
  pages?: Parsed[]
) {
  return hasFrozen()
    ? {
        ...statusInputs,
        frozenOnly: frozenOnlyOf(pages ?? (await readParsedPages())),
      }
    : statusInputs;
}

/** `readObservationStatusInputs`, for a reader (`forReaders`). */
export async function readReaderStatusInputs(
  corrections: Correction[],
  read?: Promise<Observation[]>,
  pages?: Parsed[]
) {
  return forReaders(
    await readObservationStatusInputs(corrections, read),
    pages
  );
}
