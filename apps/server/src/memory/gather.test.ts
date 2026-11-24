import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { readSettings, setSettings } from "../core/settings";
import { Correction } from "../records/observation";
import type { FileEntry } from "../records/unit";
import { ARCHIVE } from "../sources/archived";
import { whatsappFixture } from "../sources/store-fixtures";
import { copyWhatsapp } from "../sources/whatsapp";
import { gather } from "./gather";
import { CORRECTIONS, FILES } from "./memory-files";
import { loadTruth } from "./read-truth";
import { localDate } from "./zones";

const read = (ref: string): FileEntry => ({
  description: "a receipt for a made-up order",
  hash: "0123456789abcdef",
  ref,
  schemaVersion: 1,
  text: "MADE-UP SHOP, TOTAL 12.00",
});

test("a processing run shows a file he deleted as a tag, never its description", async () => {
  const before = readSettings().sources;
  const { add, now, source } = whatsappFixture();
  add(1, "P1", 1, null, 300, "Media/120@g.us/a/photo.jpg");
  copyWhatsapp(source, ARCHIVE, now);
  const entry = read("whatsapp:120@g.us/P1");
  writeFileSync(FILES, `${JSON.stringify(entry)}\n`);
  const day = localDate(new Date(now).toISOString());
  const window = { from: day, to: day };
  const run = async () =>
    gather(
      window,
      { resolve: () => null, truth: await loadTruth() },
      { files: false }
    ).then((e) => e.built.map((b) => b.text).join("\n"));
  try {
    setSettings({ sources: ["whatsapp"] });
    expect(await run()).toContain(entry.description as string);
    // His word, as his door records it: the file's ref, `file:<ref>`.
    writeFileSync(
      CORRECTIONS,
      `${JSON.stringify(
        Correction.parse({
          at: new Date(now).toISOString(),
          kind: "deleted",
          refs: [`file:${entry.ref}`],
          said: "that goes",
          schemaVersion: 1,
          withSources: false,
        })
      )}\n`,
      { flag: "a" }
    );
    const after = await run();
    expect(after).not.toContain(entry.description as string);
    expect(after).toContain("[photo");
  } finally {
    setSettings({ sources: before });
    rmSync(FILES, { force: true });
    rmSync(CORRECTIONS, { force: true });
    rmSync(ARCHIVE, { force: true, recursive: true });
  }
});
