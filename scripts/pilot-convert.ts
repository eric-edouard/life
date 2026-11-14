// `bun scripts/pilot-convert.ts`: one time, turns the pilot's earlier answers into the folders the pilot reads now. An old
// file (`pilot/<read>/<label>/<key>.json`: the reply, its messages, `wording` the digest of its prompt) becomes one
// stored read reply (`ReadReply`) in `pilot/<read>/<label>-<wording>/`, through `storeReply`; a folder that exists is left
// alone, so a second run changes nothing. The old folders stay. Writes only in the pilot's folder, never in `memory/`.
// Prints counts by read, label and digest, never a word. It goes with the last trial that compares against old answers.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "@life/server/src/core/files";
import { storeReply } from "@life/server/src/memory/exchange-reads";
import { runAt } from "@life/server/src/memory/memory-files";
import { READ_NAMES, ReadReply } from "@life/server/src/records/read-reply";
import { eventKey } from "@life/server/src/records/source";
import { KEPT, readSet, trialPath } from "./memory-pilot";

/** An earlier pilot file: a stored line without when and which read, its prompt's digest called `wording`. */
const Old = ReadReply.omit({
  at: true,
  promptDigest: true,
  read: true,
  schemaVersion: true,
})
  .extend({ wording: ReadReply.shape.promptDigest })
  // The candidates an earlier trial stored beside a reply are left behind.
  .strip();

const JSON_FILE = /\.json$/;
const FOLDER = /-[0-9a-f]{16}$/;

/**
 * Converts every earlier folder under `root`; `atOf` gives a message's instant by its key (the month file it is stored
 * in), the run's instant when it is unknown. Returns the number of files by `<read> <label> <digest>` and what became
 * of them: `converted`, `left alone` (its folder existed), `invalid`.
 */
export function convertAll(
  root: string,
  atOf: (key: string) => string | undefined
) {
  const counts = new Map<string, number>();
  const count = (what: string) => counts.set(what, (counts.get(what) ?? 0) + 1);
  for (const read of READ_NAMES) {
    const readDir = trialPath([read], root);
    const labels = existsSync(readDir) ? readdirSync(readDir) : [];
    const existed = new Set(labels);
    for (const label of labels.filter((l) => !FOLDER.test(l))) {
      for (const file of readdirSync(join(readDir, label))) {
        const old = Old.safeParse(readJson(join(readDir, label, file)));
        if (!old.success) {
          count(`${read} ${label} invalid`);
          continue;
        }
        const { wording, ...kept } = old.data;
        const folder = `${label}-${wording}`;
        const what = `${read} ${label} ${wording}`;
        if (existed.has(folder)) {
          count(`${what} left alone`);
          continue;
        }
        const at = runAt(kept.madeBy.run);
        storeReply(
          ReadReply.parse({
            ...kept,
            at,
            promptDigest: wording,
            read,
            schemaVersion: 1,
          }),
          atOf(kept.messages[0] as string) ?? at,
          trialPath([read, folder], root)
        );
        count(`${what} converted`);
      }
    }
  }
  return counts;
}

if (import.meta.main) {
  const names = readdirSync(join(KEPT, "sets")).map((n) =>
    n.replace(JSON_FILE, "")
  );
  const at = new Map(
    names.flatMap((n) =>
      readSet(n).flatMap((s) => s.batch.flat().map((e) => [eventKey(e), e.at]))
    )
  );
  console.table(
    [...convertAll(KEPT, (key) => at.get(key))].map(([what, files]) => ({
      files,
      what,
    }))
  );
}
