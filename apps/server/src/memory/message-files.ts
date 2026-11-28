import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { z } from "zod";
import { clock, daysBefore, MIN } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { digest } from "../core/hash";
import { log } from "../core/log";
import type { Engine } from "../core/names";
import { exec } from "../core/proc";
import { isOnline } from "../models/llm";
import { isPromptVersion } from "../models/prompt-parts";
import type { SourceEvent, SourceFile } from "../records/source";
import { FileEntry } from "../records/unit";
import { lifelogMissing } from "../sources/voice-server-call";
import { emlxPart } from "../sources/mail";
import { readVoiceNoteWords, toOggOpus } from "../sources/voice-notes";
import { fileRefOf, isGone } from "./deletions";
import { deletionsNow, FILES, runAt } from "./memory-files";
import { begin, chunks, inBatches, readsOf } from "./run";
import { dayUnitId } from "./unit-ids";
import { dayNow, localDate } from "./zones";

// A message's files: each read once into memory/files.jsonl, when its message arrives (`describeFilesOnArrival`, from
// the watcher) or at night (`describeFiles`, from `gather`), then shown as a line of its message (`showFiles`) with
// what was read off it, so every step, search and the connector see it with no path of their own. A voice note (a
// message's audio) is heard by lifelog's speech pipeline, its words kept like a PDF's text. Video and a file never
// read on this Mac stay a tag.

const MESSAGE_FILE_DESCRIPTION_PROMPT = "message-file-description.v1";
const PER_CALL = 8;
/**
 * The model-described files of one day that arrival describes (about $0.02 a day); the rest stay tags until the night.
 * The daytime pass (PR 4b) absorbs it by adding today's `memory.files` runs marked `arrival: true` to its day sum, then
 * this constant goes.
 */
export const FILES_ON_ARRIVAL_A_DAY = 100;
/** The words kept of a file. */
const TEXT_MAX = 1000;
/** The words kept of a voice note: ten minutes of speech, lifelog's longest. */
const VOICE_TEXT_MAX = 10_000;
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

/** What a file is, by its mime: photo, video, audio, pdf, else document. */
export const fileKindOf = (mime: string) =>
  KINDS.find(([prefix]) => mime.startsWith(prefix))?.[1] ?? "document";

/** A message's own words: its text less the U+FFFC a file leaves in it. */
export const messageWordsOf = (text: string) =>
  text.replaceAll(PLACEHOLDER, "").trim();

/** A file as a line of its message: `[photo IMG_2910.HEIC, described by Life: … | text: …]`, `[video …, not on this Mac]`. */
function fileLine(f: SourceFile, e: FileEntry | undefined) {
  const kind = fileKindOf(f.mime);
  const read = `${e?.description ? `, described by Life: ${e.description}` : ""}${e?.text ? ` | text: ${e.text}` : ""}`;
  return `[${kind}${f.name ? ` ${f.name}` : ""}${read || (f.path ? "" : ", not on this Mac")}]`;
}

/**
 * Events with their files as lines of their text, in place of the U+FFFC a file leaves in it; an event with neither
 * text nor file is left out, but a phone call, whose line its readers write (`textOf`). Every reader of chats and
 * mail goes through it.
 */
export const showFiles = (
  events: SourceEvent[],
  known: ReadonlyMap<string, FileEntry>
) =>
  events.flatMap(({ files = [], ...e }) => {
    const text = [
      messageWordsOf(e.text),
      ...files.map((f) => fileLine(f, known.get(f.ref))),
    ]
      .filter(Boolean)
      .join("\n");
    return text || e.phoneCall ? [{ ...e, text }] : [];
  });

/** Every line the ledger read, the latest for each ref winning: what the description paths ask, so a file he deleted is never read again. */
export const keptFileLines = (): ReadonlyMap<string, FileEntry> =>
  readAppended<FileEntry, Map<string, FileEntry>>(
    FILES,
    FileEntry,
    (last) => new Map(last),
    (all, e) => {
      all.set(e.ref, e);
    }
  );

/** What Life read off each file a message carried (`keptFileLines`), a file he deleted left out: what every reader shows. */
export const readFiles = () => {
  const all = keptFileLines();
  const d = deletionsNow();
  return d.refs.size === 0
    ? all
    : new Map([...all].filter(([ref]) => !isGone(fileRefOf(ref), d)));
};

/** Whether a ledger line is of the current prompt (a line of code's own reading has no prompt). */
const isCurrent = (e: FileEntry | undefined): e is FileEntry =>
  !!e &&
  (!e.madeBy ||
    isPromptVersion(e.madeBy.prompt, MESSAGE_FILE_DESCRIPTION_PROMPT));

/**
 * Appends the lines whose ref has no current line yet: one line per ref and prompt version, however many passes (the
 * night, an arrival pass) meet the same file. Read and append are synchronous, so within a process none slips in between.
 */
function appendNew(entries: FileEntry[]) {
  const have = keptFileLines();
  appendJsonl(
    FILES,
    FileEntry,
    entries.filter((e) => !isCurrent(have.get(e.ref)))
  );
}

type Readable = SourceFile & { path: string };
/** One content: the file first met with it, by its hash, and every ref it was met under. */
interface Content {
  /** When its first message was sent: where he was then routes a voice note's Thai. */
  at: string;
  file: Readable;
  hash: string;
  refs: string[];
}
type Read = { image: string } | { text: string };

const isVoiceNote = (f: SourceFile) => f.mime.startsWith("audio/");
/** A voice note lifelog did not answer is asked again after this, by whichever pass meets it. */
const VOICE_RETRY_AFTER = 5 * MIN;
/** When each voice note lifelog did not answer was last asked, in this process. */
const voiceAskedAt = new Map<string, number>();
const isVoiceDue = (ref: string) =>
  clock().getTime() - (voiceAskedAt.get(ref) ?? 0) >= VOICE_RETRY_AFTER;

/**
 * A chat event as the readers of its files take it: a source that is not a chat (mail, Notes) keeps its audio a tag,
 * never heard (his yes is for voice messages). Its callers know the source's kind.
 */
export const asChatOrNot = (e: SourceEvent, isChat: boolean): SourceEvent =>
  isChat || !e.files?.some(isVoiceNote)
    ? e
    : { ...e, files: e.files.filter((f) => !isVoiceNote(f)) };

/**
 * Whether a file is worth reading: on this Mac, and an image, a PDF, a document or a voice note while lifelog is set up
 * and the note not asked in the last minutes (never a video).
 */
const readable = (f: SourceFile): f is Readable =>
  !!f.path &&
  (f.mime.startsWith("image/") ||
    (isVoiceNote(f) && !lifelogMissing() && isVoiceDue(f.ref)) ||
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
const words = (s: string, max = TEXT_MAX) =>
  s.replace(SPACE, " ").trim().slice(0, max).trimEnd();

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

/**
 * Read by code: a document's text, a PDF's text layer, a voice note's words (lifelog, keyed by the file's own sha256
 * so a note is paid for once; nothing while it is busy). Else the JPEG a model is shown: a photo, a scan's first page.
 */
async function prepare(
  { at, file: f, refs }: Content,
  base: string
): Promise<Read | undefined> {
  const bytes = await bytesOf(f);
  if (!bytes) {
    return;
  }
  const src = `${base}${extname(f.name ?? "") || extname(f.path)}`;
  await Bun.write(src, bytes);
  if (isVoiceNote(f)) {
    const ogg = await toOggOpus(src, f.mime);
    if (ogg === null) {
      return { text: "" };
    }
    const heard =
      ogg &&
      (await readVoiceNoteWords(ogg, { at, key: digest("sha256", bytes, 64) }));
    if (!heard) {
      for (const ref of refs) {
        voiceAskedAt.set(ref, clock().getTime());
      }
      return;
    }
    return { text: words(heard.text, VOICE_TEXT_MAX) };
  }
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
  const files = events.flatMap((e) =>
    (e.files ?? []).filter(readable).map((f) => ({ ...f, at: e.at }))
  );
  for (const { at, ...f } of new Map(files.map((x) => [x.ref, x])).values()) {
    // biome-ignore lint/performance/noAwaitInLoops: one file in memory at a time
    const bytes = refs.has(f.ref) ? undefined : await open(f);
    const hash = bytes && digest("sha256", bytes, 16);
    const seen = hash && byHash.get(hash);
    if (seen) {
      copies.push({ ...seen, ref: f.ref });
    } else if (hash) {
      const same = fresh.get(hash);
      fresh.set(hash, {
        at: same?.at ?? at,
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
    z.object({
      description: z.string(),
      id: z.string(),
      text: z.string().nullish(),
    })
  ),
});

/**
 * Reads each file the window's messages carry that memory/files.jsonl has no line for: a copy of one read before gets
 * its line, a document or a PDF's text layer is read by code, a photo or a scan is described by the fast model, a few
 * per call, `atMost` of them (the rest `waiting`; an arrival pass sets it and its run is logged `arrival: true`). A failed
 * call is counted in `failed` and logged; its files stay tags until the next run tries them again (`failedRefs`).
 * ponytail: unlike the other steps, a failed call does not fail the night (one photo a model refuses would fail every
 * night for a week); the nightly email counts it.
 */
export async function describeFiles(
  events: SourceEvent[],
  { atMost, engine }: { atMost?: number; engine?: Engine } = {}
) {
  const step = await begin(
    "files",
    "fast",
    {
      prompt: MESSAGE_FILE_DESCRIPTION_PROMPT,
      ...(atMost === undefined ? {} : { arrival: true }),
    },
    engine
  );
  const { copies, fresh } = await triage(
    events,
    [...keptFileLines().values()].filter(isCurrent)
  );
  /** The ledger's lines for one content, one per ref it was met under. */
  const lines = (
    { hash, refs }: Content,
    read: Omit<FileEntry, "hash" | "ref" | "schemaVersion">
  ) => refs.map((ref): FileEntry => ({ hash, ref, schemaVersion: 1, ...read }));
  const eventOfRef = new Map(
    events.flatMap((e) => (e.files ?? []).map((f) => [f.ref, e] as const))
  );
  const tmp = await mkdtemp(join(tmpdir(), "life-files-"));
  try {
    const prepared: (Content & Read)[] = [];
    for (const [i, c] of [...fresh.values()].entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: one file in memory at a time
      const got = await prepare(c, join(tmp, String(i)));
      if (got) {
        prepared.push({ ...c, ...got });
      }
    }
    const read = prepared.flatMap((p) =>
      "text" in p ? lines(p, p.text ? { text: p.text } : {}) : []
    );
    appendNew([...copies, ...read]);
    const images = prepared.filter((p) => "image" in p);
    const shown = images.slice(0, atMost);
    const madeBy = step.madeBy(MESSAGE_FILE_DESCRIPTION_PROMPT);
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
            prompt: MESSAGE_FILE_DESCRIPTION_PROMPT,
            reads: readsOf(
              batch
                .flatMap((b) => b.refs)
                .flatMap((r) => eventOfRef.get(r) ?? [])
                .map((e) => ({ source: e.source, unit: dayUnitId(e) }))
            ),
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
        const [description, text] = [words(r.description), words(r.text ?? "")];
        return b
          ? lines(b, {
              madeBy,
              ...(description ? { description } : {}),
              ...(text ? { text } : {}),
            })
          : [];
      });
      described += entries.length;
      appendNew(entries);
    };
    await inBatches(chunks(shown, PER_CALL), step, describe);
    const have = keptFileLines();
    const waiting = new Set(images.slice(shown.length).flatMap((p) => p.refs));
    const summary = step.end({
      copied: copies.length,
      described,
      // Without them a PDF or a photo is not read (checked here, not in `checks`: they have nothing to do with acting).
      missing: ["ffmpeg", "pdftotext", "sips"].filter((b) => !Bun.which(b)),
      read: read.length,
      waiting: waiting.size,
    });
    return {
      ...summary,
      // The readable files still with no current line, but those left waiting: failed or unreadable, tried again at night.
      failedRefs: events
        .flatMap((e) => e.files ?? [])
        .filter(readable)
        .map((f) => f.ref)
        .filter((r) => !(isCurrent(have.get(r)) || waiting.has(r))),
    };
  } finally {
    await rm(tmp, { force: true, recursive: true });
  }
}

/**
 * How many contents the model described on `day`, by their hash (one content met under several refs counts once). Only
 * lines whose run id starts within a day of `day` reach `localDate` (a zone can shift the day by one), so a long ledger costs a prefix check each.
 * The night's runs count too (a 3am night describing yesterday's files spends today's): the limit is a ceiling on a
 * day's spend, whoever spent it, and the night's leftovers are few.
 */
const describedOn = (known: ReadonlyMap<string, FileEntry>, day: string) => {
  const near = new Set([daysBefore(day, 1), day, daysBefore(day, -1)]);
  return new Set(
    [...known.values()].flatMap((e) =>
      e.madeBy &&
      near.has(e.madeBy.run.slice(0, 10)) &&
      localDate(runAt(e.madeBy.run)) === day
        ? [e.hash]
        : []
    )
  ).size;
};

/**
 * The events whose files arrival describes now, cut to those files: readable, with no current line (`known`) and not
 * among `attempted`; and how many contents may still be model-described on `day` (`FILES_ON_ARRIVAL_A_DAY` less
 * today's, counted from the lines).
 */
export function filesDueOnArrival(
  events: SourceEvent[],
  known: ReadonlyMap<string, FileEntry>,
  attempted: ReadonlySet<string>,
  day = dayNow()
) {
  const due = events.flatMap((e) => {
    const files = (e.files ?? []).filter(
      (f) =>
        readable(f) && !isCurrent(known.get(f.ref)) && !attempted.has(f.ref)
    );
    return files.length > 0 ? [{ ...e, files }] : [];
  });
  // Nothing due: nothing counted (the ledger is not walked every tick).
  return {
    atMost:
      due.length === 0
        ? 0
        : Math.max(0, FILES_ON_ARRIVAL_A_DAY - describedOn(known, day)),
    due,
  };
}

/** The refs an arrival pass tried and got no line for: not tried again by this process, the night retries them. */
const triedOnArrival = new Set<string>();

/**
 * Describes the files of today's `events` that have no line yet (the watcher, after each publish, never awaited by its
 * tick): nothing when none is due. Offline or with the day's limit spent, it still reads what costs no model call (a
 * document, a PDF, a voice note) and describes no image.
 * ponytail: a failed file is not retried until a restart, the night takes it within its 7 days; a backoff if that
 * matters. A voice note is the exception: lifelog busy, the next tick asks again (local, nothing paid twice).
 */
export async function describeFilesOnArrival(events: SourceEvent[]) {
  const { atMost, due } = filesDueOnArrival(
    events,
    keptFileLines(),
    triedOnArrival
  );
  const online = due.length > 0 && (await isOnline());
  // Offline, only what code reads: a photo waits for its model.
  const read = online
    ? due
    : due.flatMap((e) => {
        const files = e.files.filter((f) => !f.mime.startsWith("image/"));
        return files.length > 0 ? [{ ...e, files }] : [];
      });
  if (read.length === 0) {
    return;
  }
  const described = await describeFiles(read, {
    atMost: online ? atMost : 0,
  });
  const voiceNotes = new Set(
    read.flatMap((e) => e.files.filter(isVoiceNote).map((f) => f.ref))
  );
  for (const ref of described.failedRefs) {
    if (!voiceNotes.has(ref)) {
      triedOnArrival.add(ref);
    }
  }
  return described;
}

/**
 * Hears the voice notes of `events` that have no line yet, and nothing else (the event reader, before it matches;
 * a backfill): no model call. Nothing to hear, no run.
 */
export function hearVoiceNotes(events: SourceEvent[]) {
  const known = keptFileLines();
  const due = events.flatMap((e) => {
    const files = (e.files ?? []).filter(
      (f) => readable(f) && isVoiceNote(f) && !isCurrent(known.get(f.ref))
    );
    return files.length > 0 ? [{ ...e, files }] : [];
  });
  return due.length === 0 ? undefined : describeFiles(due, { atMost: 0 });
}
