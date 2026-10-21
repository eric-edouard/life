import { existsSync } from "node:fs";
import { z } from "zod";

// Truth: owner-approved, in git, the only data that must survive a rebuild.

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase-slug");
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });

const Handles = z
  .object({
    email: z.array(z.email()).default([]),
    lifelog: z.uuid().optional(),
    phone: z.array(z.string().regex(/^\+\d{6,15}$/)).default([]),
    telegram: z.string().optional(),
    // Phone numbers in E.164.
    whatsapp: z.array(z.string().regex(/^\+\d{6,15}$/)).default([]),
  })
  .strict();

export const Person = z
  .object({
    aliases: z.array(z.string()).default([]),
    handles: Handles.default({ email: [], phone: [], whatsapp: [] }),
    id: slug,
    language: z.enum(["en", "fr", "th"]).optional(),
    name: z.string().min(1),
    projects: z.array(slug).default([]),
    relation: z.string().optional(),
  })
  .strict();
export type Person = z.infer<typeof Person>;

export const PeopleFile = z
  .object({ people: z.array(Person), schemaVersion: z.literal(1) })
  .strict();

export const Chat = z
  .object({
    // Beeper chat id. Which projects a chat belongs to is in `Project.chats`.
    id: z.string().startsWith("!"),
    name: z.string(),
    // WhatsApp chats: the chat id in Life's archive (`<phone>@s.whatsapp.net`, `<id>@g.us` or `<id>@lid`).
    whatsapp: z.string().optional(),
  })
  .strict();
export type Chat = z.infer<typeof Chat>;

export const ChatsFile = z
  .object({ chats: z.array(Chat), schemaVersion: z.literal(1) })
  .strict();

/** The owner's life areas (truth/areas.yaml): the one area vocabulary memory files things under. */
export const Area = z
  .object({
    id: slug,
    name: z.string().min(1),
  })
  .strict();
export type Area = z.infer<typeof Area>;

export const AreasFile = z
  .object({ areas: z.array(Area), schemaVersion: z.literal(1) })
  .strict();

export const Project = z
  .object({
    // An id from truth/areas.yaml.
    area: slug,
    chats: z.array(z.string()).default([]),
    deadlines: z
      .array(z.object({ date: isoDate, what: z.string() }).strict())
      .default([]),
    id: slug,
    name: z.string(),
    people: z.array(slug).default([]),
    // Code repos: a folder name under ~/Work (its main worktree), or owner/name for one that is only on GitHub. The first is the project's main entry point.
    repos: z.array(z.string().min(1)).default([]),
    schemaVersion: z.literal(1),
    status: z.enum(["active", "waiting", "parked", "done"]),
  })
  .strict();
export type Project = z.infer<typeof Project>;

/** The model runner he chooses for every step (src/llm.ts, `bun life engine`). */
export const Engine = z.enum(["claude", "codex"]);
export type Engine = z.infer<typeof Engine>;
/** What can run one call: his engines, and OpenRouter for the bench alone (`llmOverride`, only on a copy of his data). */
export const Runner = z.enum([...Engine.options, "openrouter"]);
export type Runner = z.infer<typeof Runner>;

/** Who made a model's output: engine and model (switching engines re-runs nothing), the prompt version, the run. */
export const MadeBy = z
  .object({
    engine: Runner.default("claude"),
    model: z.string(),
    prompt: z.string(),
    run: z.string(),
  })
  .strict();
export type MadeBy = z.infer<typeof MadeBy>;

/**
 * One thing Life did outside itself on the owner's clear request (memory/actions.jsonl): the only history of its
 * writes. `ref` is where his words are; `before` and `after` the reminder's fields; `target` what was touched. An ask
 * for Atlas (`kind` ask, `target` atlas) has `after` {confidence, conversation?, turns?, title?, parent?}: it is a task (src/tasks.ts),
 * whose `TASK_LINES` have no `instruction` and its id as `target`: Atlas's updates and replies; Life's nudges and his steers (until 20 Oct) only parse now.
 * A reply (`after` {text}) is what Atlas told him; one on no task targets `chat`.
 */
export const TASK_LINES = ["update", "reply", "nudge", "steer"] as const;
export const Action = z
  .object({
    after: z.record(z.string(), z.unknown()),
    at: isoDateTime,
    before: z.record(z.string(), z.unknown()).optional(),
    // Also "partial: <failed step>" on an add or edit that was done but lost a private field (result ok).
    error: z.string().optional(),
    id: z.string().regex(/^act_[0-9a-f]{12}$/),
    instruction: z
      .object({ at: isoDateTime, quote: z.string(), ref: z.string() })
      .strict()
      .optional(),
    // "instinct": an email to Instinct, until 19 Oct.
    kind: z.enum([
      "add",
      "edit",
      "done",
      "remove",
      "ask",
      "instinct",
      ...TASK_LINES,
    ]),
    // A model step (until 19 Oct, the hearing), or who passed his words on; "watch": the watcher (a "hey Atlas" heard; a nudge or a steer until 20 Oct).
    madeBy: z.union([MadeBy, z.enum(["connector", "session", "watch"])]),
    result: z.enum(["ok", "failed", "duplicate"]),
    schemaVersion: z.literal(1),
    // "reminder:<numericId>", "reminder:new" (a failed add), "atlas" (an ask), a task's id (its lines), "chat" (a reply on no task) or "mailto:<address>" (Instinct, until 19 Oct).
    target: z.string(),
    // An ask heard in his speech: where the time went (spoke = instruction.at, recorded = at). `ended`: his last turn of
    // it ended; `arrived`: lifelog's feed had brought all of it. Until 19 Oct, a heard request's `heard`, `modelMs`, `actMs`.
    timing: z
      .object({
        actMs: z.int().optional(),
        arrived: isoDateTime,
        ended: isoDateTime.optional(),
        heard: isoDateTime.optional(),
        modelMs: z.int().optional(),
      })
      .strict()
      .optional(),
    why: z.string(),
  })
  .strict();
export type Action = z.infer<typeof Action>;
export type Instruction = NonNullable<Action["instruction"]>;
/** A task's own line (Atlas's update, an old nudge or steer), not something done on his request: the one test. */
export const isTaskLine = (a: Action) =>
  (TASK_LINES as readonly string[]).includes(a.kind);

/** Where a unit or an observation comes from. */
const SourceName = z.enum([
  "lifelog",
  "beeper",
  "whatsapp",
  "imessage",
  "mail",
  "git",
  "notes",
]);

/**
 * A file a message carries, as its source resolved it; files.ts renders it as a line of the message. `ref` says where
 * it was met, stable without the file: `imessage:<attachment guid>`, `whatsapp:<chat>/<msg>`, `beeper:<mxc url>`,
 * `mail:<Message-ID>#<IMAP part>`, `notes:<attachment id>`.
 */
export const SourceFile = z
  .object({
    mime: z.string(),
    name: z.string().optional(),
    // The file on this Mac (mail: the .emlx when the part is inside it); absent when it is not here.
    path: z.string().optional(),
    ref: z.string(),
  })
  .strict();
export type SourceFile = z.infer<typeof SourceFile>;

/**
 * A file as every reader makes one: typed by its name or path when the source gives no type (or only "bytes", as mail
 * often types a PDF), `path` only if it is there.
 */
export const sourceFile = (f: {
  mime?: string | null;
  name?: string | null;
  path?: string | null;
  ref: string;
}): SourceFile => ({
  mime:
    (f.mime !== "application/octet-stream" && f.mime) ||
    Bun.file(f.name || f.path || "").type,
  ...(f.name ? { name: f.name } : {}),
  ...(f.path && existsSync(f.path) ? { path: f.path } : {}),
  ref: f.ref,
});

// A normalized source event. Ids are stable per source, so syncing twice never duplicates.
export const SourceEvent = z
  .object({
    // Git only: lines a commit added and removed, lockfiles and generated files left out.
    added: z.int().min(0).optional(),
    at: isoDateTime,
    // Mail only: Mail saw a mailing-list id or an unsubscribe link, i.e. a newsletter or a marketing send.
    bulk: z.boolean().optional(),
    chat: z.string(),
    chatName: z.string().optional(),
    // WhatsApp and Beeper: the sender deleted it for everyone; the text is the archive's copy. Notes: he deleted the note.
    deleted: z.boolean().optional(),
    files: z.array(SourceFile).optional(),
    fromMe: z.boolean(),
    id: z.string(),
    removed: z.int().min(0).optional(),
    // The sender's handle as the source shows it: phone, email, Beeper participant id; git: the author's name.
    sender: z.string(),
    // lifelog has chapters, not events.
    source: SourceName.exclude(["lifelog"]),
    text: z.string(),
  })
  .strict();
export type SourceEvent = z.infer<typeof SourceEvent>;

// Memory (~/Life/docs/research/memory-pipeline.md). Plain JSON Lines under memory/, described for humans in
// docs/SCHEMA.md. Every record carries schemaVersion and, when a model judged it, the model and prompt version.

/** What a unit or observation is (owner's decision, 11 Oct). Owner-facing names in TYPE_NAMES. */
export const MemoryType = z.enum([
  "todo",
  "promise",
  "waiting",
  "decision",
  "person",
  "preference",
  "idea",
  "news",
  "nothing",
]);
export type MemoryType = z.infer<typeof MemoryType>;

/** What kind of recording a lifelog chapter is (decision 6: the fast-tier model tags it). */
export const ChapterKind = z.enum([
  "conversation",
  "small-talk",
  "media",
  "dictation",
  "customer",
]);

const Salience = z.int().min(0).max(3);
const UnitId = z.string().regex(/^u_[0-9a-f]{12}$/);
export const ObservationId = z.string().regex(/^obs_[0-9a-f]{12}$/);
/** 16 hex of SHA-256 over a unit's content. */
const ContentHash = z.string().regex(/^[0-9a-f]{16}$/);

/**
 * The salience policy: the salience from which a unit is kept and its observations are shown. Extraction reads a kept unit
 * in full; pages and searches list its claims. The owner's labels (11 Oct): salience 1 was mostly noise to him, 2 and 3
 * mostly right. A salience-1 unit stays in units/ and verdicts.jsonl, searchable; it is read only with a moment that
 * holds a kept unit.
 */
export const KEEP_AT = 2;
/** The salience from which a unit is worth a searchable line, and is read with its moment. */
export const SEARCHABLE_AT = 1;
/** Inferred people below this confidence are remembered but not linked to; the next day that sees them asks again. */
export const INFERRED_USE_AT = 0.5;

/**
 * memory/verdicts.jsonl: the moments model's judgement of one unit's content (`unit` + `hash`), append-only. The latest
 * line for a (unit, hash) wins; a unit a code rule dropped (`Unit.drop`) has none that counts.
 */
export const Verdict = z
  .object({
    // An id from truth/areas.yaml, or null when none fits.
    area: slug.nullable(),
    hash: ContentHash,
    kind: ChapterKind.optional(),
    madeBy: MadeBy,
    reason: z.string(),
    salience: Salience,
    schemaVersion: z.literal(1),
    // 1-3 lowercase English tags for what the unit is about (`bun life memory topics`); none before memory-triage.v3.
    topics: z.array(z.string().min(1)).max(3).default([]),
    type: MemoryType,
    unit: UnitId,
    // A date or deadline the unit carries, whatever its type.
    when: isoDate.nullable(),
  })
  .strict();
export type Verdict = z.infer<typeof Verdict>;

/**
 * memory/files.jsonl: what Life read off one file a message carried (`SourceFile.ref`), append-only; the latest line for
 * a ref wins. `what` is the model's one sentence; `text` the words on the file (by code: a PDF's text layer, a
 * document; no `madeBy`). `hash`: 16 hex of SHA-256 over its bytes, so a copy met elsewhere is read once.
 */
export const FileEntry = z
  .object({
    hash: ContentHash,
    madeBy: MadeBy.optional(),
    ref: z.string(),
    schemaVersion: z.literal(1),
    text: z.string().optional(),
    what: z.string().optional(),
  })
  .strict();
export type FileEntry = z.infer<typeof FileEntry>;

/** L1: one lifelog chapter, one chat-day or one mail thread-day. Refs, hashes and metadata; never raw text. */
export const Unit = z
  .object({
    date: isoDate,
    // The code rule that dropped the unit as obvious noise (units.ts RULES); absent when none did.
    drop: z.string().optional(),
    end: isoDateTime,
    hash: ContentHash,
    id: UnitId,
    // The conversation, chat or mail thread the unit belongs to.
    key: z.string(),
    // person:<slug> from truth/people.yaml, or unknown:<name> for a name lifelog knows and the map doesn't.
    people: z.array(z.string()),
    // lifelog: conversation#turns and jobId:turnIndex@capturedAt; chats: first and last message id; mail: message ids.
    refs: z.array(z.string()).min(1),
    schemaVersion: z.literal(1),
    source: SourceName,
    start: isoDateTime,
    stats: z
      .object({
        // Git only: lines added and removed that day, and other authors' commits by name (items counts all of them).
        added: z.int().min(0).optional(),
        chars: z.int().min(0),
        fromMe: z.int().min(0),
        items: z.int().min(0),
        others: z.record(z.string(), z.int().min(1)).optional(),
        removed: z.int().min(0).optional(),
      })
      .strict(),
    // lifelog's own chapter summary; chats and mail have none.
    summary: z.string().optional(),
    title: z.string(),
  })
  .strict();
export type Unit = z.infer<typeof Unit>;

/** memory/zones.jsonl: the owner's IANA time zone from `from` on. */
export const Zone = z
  .object({ from: isoDateTime, schemaVersion: z.literal(1), tz: z.string() })
  .strict();

/** The owner's label on a unit: does it matter, and optionally the right type and area (an id from truth/areas.yaml). memory/labels.jsonl. */
export const MemoryLabel = z
  .object({
    area: z.string().optional(),
    at: isoDateTime.optional(),
    matters: z.boolean(),
    schemaVersion: z.literal(1).optional(),
    type: MemoryType.optional(),
    unitId: UnitId,
  })
  .strict();
export type MemoryLabel = z.infer<typeof MemoryLabel>;

/** person:<slug>, project:<slug> or area:<slug> (design §3.2). */
const EntityRef = z.string().regex(/^(person|project|area):[a-z0-9-]+$/);

/** How a claim was said: as true, as settled for later, about a third person, or only conditionally (a hypothesis, a quote). */
export const Modality = z.enum(["fact", "plan", "reported", "conditional"]);

const MomentId = z.string().regex(/^mom_[0-9a-f]{12}$/);
/** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, local. */
export const LocalTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/);

/**
 * memory/moments/<day>.jsonl: one thing that happened or is planned in the owner's life (a trip, a dinner, a flight), found by
 * the moments step from one day of units across every channel. A day's file is rewritten when that day is read again;
 * a moment seen again on a later day keeps its id there; the latest day's line is the moment's current state, and its
 * units are those of all its lines (`momentsNow`).
 */
export const Moment = z
  .object({
    /** The units of the day that are copies of another unit of the moment (two recordings of one stretch of talk). */
    copies: z.array(UnitId),
    /** The day whose units this line was read from. */
    day: isoDate,
    end: LocalTime.nullable(),
    id: MomentId,
    importance: z.int().min(1).max(3),
    madeBy: MadeBy,
    people: z.array(
      z
        .object({
          ref: z.string().regex(/^(person|unknown):/),
          role: z.enum(["with", "told", "organizer"]),
        })
        .strict()
    ),
    place: z.string().min(1).nullable(),
    schemaVersion: z.literal(1),
    start: LocalTime.nullable(),
    status: z.enum(["happened", "planned", "cancelled", "unsure"]),
    title: z.string().min(1).max(200),
    units: z.array(UnitId).min(1),
    why: z.string().max(300),
  })
  .strict();
export type Moment = z.infer<typeof Moment>;

/** L2: one small dated claim, cited to the exact place in its source. memory/observations/<yyyy-mm>.jsonl. */
export const Observation = z
  .object({
    /** The one person or project the claim is about (from memory-extract.v3; `entities` also lists who it mentions). */
    about: EntityRef.optional(),
    /** An id from truth/areas.yaml, or null when none fits. */
    area: slug.nullable(),
    /** When it was said or written (the cited line's time). */
    at: isoDateTime,
    confidence: z.number().min(0).max(1),
    /** Local day of `at` in `tz`. */
    date: isoDate,
    /** People and projects the claim is about. */
    entities: z.array(EntityRef),
    /** obs_ + hash of unit, type, quote and claim: re-extracting the same thing gives the same id. */
    id: ObservationId,
    madeBy: MadeBy.extend({ unitHash: z.string() }).strict(),
    modality: Modality.optional(),
    /** Verbatim from the source text the model read; code checked it is there. */
    quote: z.string().min(1).max(600),
    salience: z.int().min(1).max(3),
    schemaVersion: z.literal(1),
    source: z
      .object({
        channel: SourceName,
        // lifelog: jobId:turnIndex@capturedAt; chats and mail: the message id.
        ref: z.string().min(1),
      })
      .strict(),
    /** Who said or wrote the cited line: person:<slug>, or unknown:<label>. */
    speaker: z.string(),
    /**
     * The handle or name the cited line's author came from (a chat sender; for a voice, lifelog's id, else its name), from
     * 21 Oct 2026: readers resolve it again (`aboutNow`), so a later identity fix needs no new reading.
     */
    speakerFrom: z.string().optional(),
    /** A readable name for an unknown speaker (the 1:1 chat's title), next to the raw id in `speaker`. */
    speakerName: z.string().optional(),
    text: z.string().min(1).max(500),
    type: MemoryType.exclude(["nothing"]),
    tz: z.string(),
    unit: UnitId,
    validFrom: isoDate.nullable(),
    validTo: isoDate.nullable(),
    /** A date or deadline the claim carries. */
    when: isoDate.nullable(),
  })
  .strict();
export type Observation = z.infer<typeof Observation>;

/** Which units an extractor version has read: memory/extracted.jsonl, one line per unit and run. */
export const Extracted = z
  .object({
    at: isoDateTime,
    observations: z.int().min(0),
    /** Written 21 Oct 2026 only (the unit's people then); ignored since: who someone is is resolved when read. */
    people: z.array(z.string()).optional(),
    prompt: z.string(),
    run: z.string(),
    schemaVersion: z.literal(1),
    unit: z.string(),
    unitHash: z.string(),
  })
  .strict();
export type Extracted = z.infer<typeof Extracted>;

/** A name Life could not map to truth/: memory/unresolved.jsonl. */
export const Unresolved = z
  .object({
    at: isoDateTime,
    date: isoDate,
    observation: z.string().optional(),
    schemaVersion: z.literal(1),
    surface: z.string().min(1),
    unit: z.string(),
    via: z.enum(["model", "speaker"]),
  })
  .strict();
export type Unresolved = z.infer<typeof Unresolved>;

/**
 * memory/supersessions.jsonl: an observation a newer one replaces, written by code (the ledger itself is never edited):
 * by extraction, when later lines of a moment show it is no longer true, or (before memory-extract.v3) while
 * consolidating a `page`. The older one holds until `validTo`.
 */
export const Supersession = z
  .object({
    at: isoDateTime,
    by: ObservationId,
    madeBy: MadeBy,
    observation: ObservationId,
    page: EntityRef.optional(),
    schemaVersion: z.literal(1),
    validTo: isoDate,
    why: z.string().max(300),
  })
  .strict();
export type Supersession = z.infer<typeof Supersession>;

/** memory/statements.jsonl: the truth benchmark, one statement per claim, frozen as he was shown it (docs/SCHEMA.md). */
export const Statement = z
  .object({
    at: isoDateTime,
    claim: z.union([ObservationId, MomentId]),
    date: isoDate,
    group: z.union([EntityRef, z.literal("events")]),
    kind: z.enum(["fact", "plan", "reported", "moment"]),
    schemaVersion: z.literal(1),
    source: SourceName.nullable(),
    text: z.string().min(1),
    units: z.array(UnitId).min(1),
  })
  .strict();
export type Statement = z.infer<typeof Statement>;

/** memory/ratings.jsonl: his answers on the check page, the latest per claim counting; null is an undo (docs/SCHEMA.md). */
export const Rating = z
  .object({
    answer: z.enum(["true", "false", "outdated", "skip"]).nullable(),
    at: isoDateTime,
    claim: z.union([ObservationId, MomentId]),
    schemaVersion: z.literal(1),
  })
  .strict();
export type Rating = z.infer<typeof Rating>;

/** memory/scores.jsonl: one line per scored run (`bun scripts/eval.ts --ratings`), its counts (docs/SCHEMA.md). */
export const Score = z
  .object({
    at: isoDateTime,
    contradicted: z.int().min(0),
    gone: z.int().min(0),
    held: z.int().min(0),
    missed: z.int().min(0),
    outdated: z.int().min(0).default(0),
    rated: z.int().min(0),
    restated: z.int().min(0),
    run: z.string(),
    schemaVersion: z.literal(1),
    trues: z.int().min(0),
    ungraded: z.int().min(0),
  })
  .strict();

const PersonRef = z.string().regex(/^person:[a-z0-9-]+$/);
/** How close someone is to the owner, in his personal life or his work: `faded` was close, not any more. */
export const Level = z.enum(["inner", "regular", "acquaintance", "faded"]);
export type Level = z.infer<typeof Level>;
const Correcting = {
  at: isoDateTime,
  note: z.string().optional(),
  schemaVersion: z.literal(1),
};

/** A page's sections, in page order (`SECTIONS`, page.ts): views and health on the owner's page only, bond on a close person's (`layoutOf`). */
export const PageSection = z.enum([
  "views",
  "health",
  "bond",
  "now",
  "history",
]);

/**
 * memory/corrections.jsonl: what the owner told Life, append-only, written by a Claude session when he says it in
 * conversation (`bun life memory correct`) and by the pages step when it finds him editing a page file. Every
 * rebuild respects it. `wrong` and `not-important` hide observations (on one page when `page` is set, else
 * everywhere); `keep-mine` is a page line that stays as written; `this-is` says a handle or name is a person,
 * `not-this-person` that it is not, `same-person` that two person refs are one (`from` folds into `to`); `reread`
 * says units were read wrong (a fact under the wrong person, say): each is extracted again when its day is next read.
 */
export const Correction = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...Correcting,
        kind: z.enum(["wrong", "not-important"]),
        // Observations (obs_…) and, from 18 Oct, moments (mom_…).
        observations: z.array(z.union([ObservationId, MomentId])).min(1),
        page: EntityRef.optional(),
      })
      .strict(),
    z
      .object({
        ...Correcting,
        kind: z.literal("keep-mine"),
        page: EntityRef,
        section: PageSection,
        text: z.string().min(1),
      })
      .strict(),
    z
      .object({
        ...Correcting,
        kind: z.literal("this-is"),
        person: PersonRef,
        surface: z.string().min(1),
      })
      .strict(),
    z
      .object({
        ...Correcting,
        kind: z.literal("not-this-person"),
        person: PersonRef,
        surface: z.string().min(1),
      })
      .strict(),
    z
      .object({
        ...Correcting,
        from: PersonRef,
        kind: z.literal("same-person"),
        to: PersonRef,
      })
      .strict(),
    z
      .object({
        ...Correcting,
        kind: z.literal("reread"),
        units: z.array(UnitId).min(1),
      })
      .strict(),
    z
      .object({
        ...Correcting,
        kind: z.literal("closeness"),
        person: PersonRef,
        personal: Level.optional(),
        work: Level.optional(),
      })
      .strict(),
  ])
  .refine((c) => c.kind !== "closeness" || !!(c.personal || c.work), {
    message: "a closeness correction names a personal or a work level",
  });
export type Correction = z.infer<typeof Correction>;

/** The id prefix of people Life inferred; truth ids never start with it, so the two never collide. */
export const INFERRED_PREFIX = "inf-";

/**
 * memory/people-inferred.jsonl: who Life thinks an unknown handle or name is, from the messages and observations
 * around it. Model-owned and append-only (the latest record for a surface wins); used automatically below truth/ and
 * the owner's corrections, and never written into truth/.
 */
export const InferredPerson = z
  .object({
    area: slug.nullable(),
    at: isoDateTime,
    confidence: z.number().min(0).max(1),
    /** Quotes from the messages the guess rests on, each in a unit: code checked every quote is in it. */
    evidence: z
      .array(z.object({ quote: z.string().min(1), unit: z.string() }).strict())
      .min(1),
    id: z.string().regex(/^inf-[a-z0-9-]+$/),
    madeBy: MadeBy,
    /** A name when the messages give one, else a short description ("the plumber changing the shop sink"). */
    name: z.string().min(1),
    project: slug.nullable(),
    relation: z.string().min(1),
    schemaVersion: z.literal(1),
    /** Handles (phone, WhatsApp id, Beeper id) or names this person goes by. */
    surfaces: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type InferredPerson = z.infer<typeof InferredPerson>;

/**
 * memory/repos-inferred.jsonl: which project a code repo belongs to, as Life guesses (folder name under ~/Work, or
 * owner/name for a repo only on GitHub). Model-owned and append-only (the latest record for a repo wins); used at once
 * below truth/ (`Project.repos`) and never written into it. A repo that fits no project may carry the name and purpose
 * of a project the owner might want (`newProject`: "Cove: macOS call recorder"); it becomes one only when he says so.
 */
export const RepoGuess = z
  .object({
    area: slug.nullable(),
    at: isoDateTime,
    madeBy: MadeBy,
    newProject: z.string().min(1).nullable(),
    project: slug.nullable(),
    repo: z.string().min(1),
    schemaVersion: z.literal(1),
    why: z.string().min(1).max(300),
  })
  .strict();
export type RepoGuess = z.infer<typeof RepoGuess>;

/**
 * memory/closeness.jsonl: how close each person is to the owner, personal and work apart, as the fast model judged it
 * from what code counted (`closeness.ts`): `service` is a business or a bot, not a person. `counts` is the counts it
 * judged, rounded, so it is asked again only when they move. The latest line per person holds; his `closeness`
 * correction wins over it.
 */
export const Closeness = z
  .object({
    at: isoDateTime,
    counts: z.string(),
    madeBy: MadeBy,
    person: PersonRef,
    personal: Level,
    schemaVersion: z.literal(1),
    service: z.boolean(),
    why: z.string().min(1).max(300),
    work: Level,
  })
  .strict();
export type Closeness = z.infer<typeof Closeness>;
