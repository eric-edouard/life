import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { z } from "zod";
import { appendJsonl } from "../core/files";
import { digest } from "../core/hash";
import { log } from "../core/log";
import type { Engine } from "../core/names";
import { exec } from "../core/proc";
import { stamp } from "../models/llm";
import type { SourceEvent, SourceFile } from "../records/source";
import { FileEntry } from "../records/unit";
import { emlxPart } from "../sources/mail";
import { FILES, readFiles } from "./ledger";
import { begin, chunks, inBatches } from "./run";

// A message's files: each read once into memory/files.jsonl (`describeFiles`, from `gather`), then shown as a line of
// its message (`showFiles`) with what was read off it, so every step, search and the connector see it with no path of
// their own. Video, voice notes and a file never read on this Mac stay a tag.

const FILES_PROMPT = "files.v1";
const PER_CALL = 8;
/** The words kept of a file. */
const TEXT_MAX = 1000;
/** The long side, in pixels, of the image a model is shown. */
const IMAGE_PX = 1600;
/** What textutil reads as text: Word, RTF, OpenDocument text, plain text. */
const DOCUMENT = /msword|rtf$|opendocument\.text|wordprocessingml|^text\/plain/;
/** What Messages leaves in a message's text where a file was: U+FFFC. */
const PLACEHOLDER = String.fromCharCode(0xff_fc);
const KINDS: [string, string][] = [
  ["image/", "photo"],
  ["video/", "video"],
  ["audio/", "audio"],
  ["application/pdf", "pdf"],
];
const SPACE = /\s+/g;

/** A file as a line of its message: `[photo IMG_2910.HEIC, described by Life: … | text: …]`, `[video …, not on this Mac]`. */
function fileLine(f: SourceFile, e: FileEntry | undefined) {
  const kind =
    KINDS.find(([mime]) => f.mime.startsWith(mime))?.[1] ?? "document";
  const read = `${e?.what ? `, described by Life: ${e.what}` : ""}${e?.text ? ` | text: ${e.text}` : ""}`;
  return `[${kind}${f.name ? ` ${f.name}` : ""}${read || (f.path ? "" : ", not on this Mac")}]`;
}

/**
 * Events with their files as lines of their text, in place of the U+FFFC a file leaves in it; an event with neither
 * text nor file is left out. Every reader of chats and mail goes through it.
 */
export const showFiles = (
  events: SourceEvent[],
  known: ReadonlyMap<string, FileEntry>
) =>
  events.flatMap(({ files = [], ...e }) => {
    const text = [
      e.text.replaceAll(PLACEHOLDER, "").trim(),
      ...files.map((f) => fileLine(f, known.get(f.ref))),
    ]
      .filter(Boolean)
      .join("\n");
    return text ? [{ ...e, text }] : [];
  });

type Readable = SourceFile & { path: string };
/** One content: the file first met with it, by its hash, and every ref it was met under. */
interface Content {
  file: Readable;
  hash: string;
  refs: string[];
}
type Read = { image: string } | { text: string };

/** Whether a file is worth reading: on this Mac, and an image, a PDF or a document (never a video or a voice note). */
const readable = (f: SourceFile): f is Readable =>
  !!f.path &&
  (f.mime.startsWith("image/") ||
    f.mime === "application/pdf" ||
    DOCUMENT.test(f.mime));

/**
 * A file's bytes: the file, or its part of the .emlx that holds it; nothing when it is gone, unreadable or empty (a
 * download that failed: every empty file has the same hash, and must not take another's line).
 */
const bytesOf = (f: Readable): Promise<Buffer | undefined> =>
  (f.path.endsWith(".emlx")
    ? Promise.resolve().then(() => emlxPart(f.path, f.ref))
    : Bun.file(f.path)
        .bytes()
        .then((b) => Buffer.from(b))
  )
    .then((b) => (b?.length ? b : undefined))
    .catch(() => undefined);

/** The words kept of a file's text, on one line. */
const words = (s: string) =>
  s.replace(SPACE, " ").trim().slice(0, TEXT_MAX).trimEnd();

/** A program's output, or nothing when it failed or is missing (logged): the file stays a tag, and is tried again. */
async function run(cmd: string[]) {
  const r = await exec(cmd);
  if (r.code !== 0) {
    log("file.read", { cmd: cmd[0], error: r.stderr.trim().slice(-200) });
    return;
  }
  return r.stdout;
}

/** `src` as a JPEG at `out` with its long side at most `px` pixels; false when `sips` failed (logged). */
export async function toJpeg(src: string, out: string, px: number) {
  const made = await run([
    ...["sips", "-s", "format", "jpeg", "-Z", String(px), src],
    ...["--out", out],
  ]);
  return made !== undefined;
}

/** Read by code: a document's text, a PDF's text layer. Else the JPEG a model is shown: a photo, a scan's first page. */
async function prepare(f: Readable, base: string): Promise<Read | undefined> {
  const bytes = await bytesOf(f);
  if (!bytes) {
    return;
  }
  const src = `${base}${extname(f.name ?? "") || extname(f.path)}`;
  await Bun.write(src, bytes);
  if (DOCUMENT.test(f.mime)) {
    const out = await run(["textutil", "-convert", "txt", "-stdout", src]);
    return out === undefined ? undefined : { text: words(out) };
  }
  const layer =
    f.mime === "application/pdf"
      ? words((await run(["pdftotext", src, "-"])) ?? "")
      : "";
  if (layer) {
    return { text: layer };
  }
  const image = `${base}.jpg`;
  return (await toJpeg(src, image, IMAGE_PX)) ? { image } : undefined;
}

/**
 * The files of `events` worth reading that the ledger has no current line for (`known`: an older prompt's lines aside),
 * by their bytes (`open`): a copy of one read before (same hash) gets that line under its own ref; each new content is
 * listed once, by hash, with every ref it was met under.
 */
export async function triage(
  events: SourceEvent[],
  known: FileEntry[],
  open = bytesOf
) {
  const refs = new Set(known.map((e) => e.ref));
  const byHash = new Map(known.map((e) => [e.hash, e]));
  const copies: FileEntry[] = [];
  const fresh = new Map<string, Content>();
  const files = events.flatMap((e) => e.files ?? []).filter(readable);
  for (const f of new Map(files.map((x) => [x.ref, x])).values()) {
    // biome-ignore lint/performance/noAwaitInLoops: one file in memory at a time
    const bytes = refs.has(f.ref) ? undefined : await open(f);
    const hash = bytes && digest("sha256", bytes, 16);
    const seen = hash && byHash.get(hash);
    if (seen) {
      copies.push({ ...seen, ref: f.ref });
    } else if (hash) {
      const same = fresh.get(hash);
      fresh.set(hash, {
        file: same?.file ?? f,
        hash,
        refs: [...(same?.refs ?? []), f.ref],
      });
    }
  }
  return { copies, fresh };
}

const Reply = z.object({
  files: z.array(
    z.object({ id: z.string(), text: z.string().nullish(), what: z.string() })
  ),
});

/**
 * Reads each file the window's messages carry that memory/files.jsonl has no line for: a copy of one read before gets
 * its line, a document or a PDF's text layer is read by code, a photo or a scan is described by the fast model, a few
 * per call. A failed call is counted in `failed` and logged; its files stay tags until the next run tries them again.
 * ponytail: unlike the other steps, a failed call does not fail the night (one photo a model refuses would fail every
 * night for a week); the nightly email counts it.
 */
export async function describeFiles(events: SourceEvent[], engine?: Engine) {
  const step = await begin("files", "fast", { prompt: FILES_PROMPT }, engine);
  const { copies, fresh } = await triage(
    events,
    [...readFiles().values()].filter(
      (e) => !e.madeBy || e.madeBy.prompt === FILES_PROMPT
    )
  );
  /** The ledger's lines for one content, one per ref it was met under. */
  const lines = (
    { hash, refs }: Content,
    read: Omit<FileEntry, "hash" | "ref" | "schemaVersion">
  ) => refs.map((ref): FileEntry => ({ hash, ref, schemaVersion: 1, ...read }));
  const tmp = await mkdtemp(join(tmpdir(), "life-files-"));
  try {
    const prepared: (Content & Read)[] = [];
    for (const [i, c] of [...fresh.values()].entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: one file in memory at a time
      const got = await prepare(c.file, join(tmp, String(i)));
      if (got) {
        prepared.push({ ...c, ...got });
      }
    }
    const read = prepared.flatMap((p) =>
      "text" in p ? lines(p, p.text ? { text: p.text } : {}) : []
    );
    await appendJsonl(FILES, FileEntry, [...copies, ...read]);
    const shown = prepared.filter((p) => "image" in p);
    const madeBy = stamp(step.llm, FILES_PROMPT, step.run);
    let described = 0;
    /** One call on `batch`; a failed call on several files tries each alone, so a bad image leaves only itself a tag. */
    const describe = async (batch: typeof shown, dir: string) => {
      const reply = await step.attempt(async () =>
        Reply.parse(
          await step.ask({
            dir,
            images: batch.map((b) => b.image),
            input: {
              files: batch.map((b, i) => ({
                id: String(i + 1),
                name: b.file.name ?? null,
                type: b.file.mime,
              })),
            },
            prompt: FILES_PROMPT,
          })
        )
      );
      if (!reply && batch.length > 1) {
        for (const [i, b] of batch.entries()) {
          // biome-ignore lint/performance/noAwaitInLoops: one file at a time, only after its batch failed
          await describe([b], join(dir, String(i)));
        }
        return;
      }
      const entries = (reply?.files ?? []).flatMap((r) => {
        const b = batch[Number(r.id) - 1];
        const [what, text] = [words(r.what), words(r.text ?? "")];
        return b
          ? lines(b, {
              madeBy,
              ...(what ? { what } : {}),
              ...(text ? { text } : {}),
            })
          : [];
      });
      described += entries.length;
      await appendJsonl(FILES, FileEntry, entries);
    };
    await inBatches(chunks(shown, PER_CALL), step.dir, describe);
    return step.end({
      copied: copies.length,
      described,
      // Without them a PDF or a photo is not read (checked here, not in `checks`: they have nothing to do with acting).
      missing: ["pdftotext", "sips"].filter((b) => !Bun.which(b)),
      read: read.length,
    });
  } finally {
    await rm(tmp, { force: true, recursive: true });
  }
}
