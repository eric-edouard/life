// The export copies Life cannot read yet: a WhatsApp copy in `imports/whatsapp/` the archive has no rows for, or an
// assistant's export copy, whose parse throws a shape report (`core/shape-report.ts`). Worked out at read and never
// stored: the shape report alone leaves, never a word of his. Cached an hour, like the integrations' reads.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cached } from "../core/cached";
import { MIN } from "../core/clock";
import { digest } from "../core/hash";
import type { SourceName } from "../core/names";
import { type Shape, ShapeReport } from "../core/shape-report";
import { openReadOnly } from "../core/sqlite";
import { ARCHIVE, archiveDb } from "../sources/archived";
import {
  type Assistant,
  exportsDir,
  unreadableCopiesOf,
} from "../sources/assistants";
import {
  parseWhatsappExport,
  whatsappCopiesDir,
  whatsappCopyOf,
} from "../sources/whatsapp-export";

/** One export copy that cannot be read now: its source, its shape report, and the report's digest. */
export interface PausedImport {
  /** A hash of the report's JSON: the caretaker's event id is `import-paused:<digest>`. */
  digest: string;
  report: Shape;
  source: SourceName;
}

/** Where the copies and the archive are read: his data's own places, unless a test names others. */
export interface PausedImportDirs {
  archive?: string;
  data?: string;
}

const ASSISTANTS: Assistant[] = ["claude", "chatgpt"];

/** The WhatsApp archive, read-only: a copy with no export rows there is one the import has not read. */
const openArchive = (archive: string) => {
  const path = archiveDb("whatsapp", archive);
  return existsSync(path) ? openReadOnly(path) : undefined;
};

const hasExportRows = (
  db: ReturnType<typeof openArchive>,
  id: string
): boolean => {
  if (!db) {
    return false;
  }
  try {
    return Boolean(
      db.query("select 1 from messages where chat = ?").get(`export:${id}`)
    );
  } catch {
    // A store being written or not yet shaped: read the copy as one without rows.
    return false;
  }
};

/** The WhatsApp copies with no export rows whose parse throws a shape report. */
const pausedWhatsappCopies = (dirs: PausedImportDirs) => {
  const dir = whatsappCopiesDir(dirs.data);
  if (!existsSync(dir)) {
    return [];
  }
  const db = openArchive(dirs.archive ?? ARCHIVE);
  try {
    return readdirSync(dir).flatMap((file) => {
      const copy = whatsappCopyOf(file);
      if (!(copy && !hasExportRows(db, copy.id))) {
        return [];
      }
      try {
        // The archive's own parser; the owner names and zone are not needed to fail on a shape.
        parseWhatsappExport(readFileSync(join(dir, file), "utf8"), {
          atWall: (day, hm) => `${day}T${hm}:00.000Z`,
          ownerNames: [],
        });
        return [];
      } catch (error) {
        return error instanceof ShapeReport ? [error] : [];
      }
    });
  } catch {
    // A folder this read cannot list (a permission, a race): no copy is reported as paused.
    return [];
  } finally {
    db?.close();
  }
};

/** The assistant export copies whose parse throws a shape report, as their one reader finds them (parsed once). */
const pausedAssistantCopies = (dirs: PausedImportDirs) =>
  ASSISTANTS.flatMap((source) =>
    unreadableCopiesOf(source, exportsDir(source, dirs.data)).map((report) => ({
      report,
      source,
    }))
  );

const readPausedImports = (dirs: PausedImportDirs): PausedImport[] => {
  const found = new Map<string, PausedImport>();
  const add = (source: SourceName, report: ShapeReport) => {
    const { fields } = report;
    const id = digest("sha256", JSON.stringify(fields), 12);
    found.set(id, { digest: id, report: fields, source });
  };
  for (const report of pausedWhatsappCopies(dirs)) {
    add("whatsapp", report);
  }
  for (const { report, source } of pausedAssistantCopies(dirs)) {
    add(source, report);
  }
  return [...found.values()];
};

/**
 * Every export copy Life cannot read now, with its shape report: the WhatsApp copies the archive has no rows for and
 * the assistant copies whose parse throws one. Cached an hour.
 */
export const pausedImportsNow = (dirs: PausedImportDirs = {}) =>
  cached(`paused imports ${JSON.stringify(dirs)}`, 60 * MIN, () =>
    readPausedImports(dirs)
  );
