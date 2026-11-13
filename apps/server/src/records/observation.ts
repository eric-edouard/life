import { z } from "zod";
import { digest } from "../core/hash";
import { SourceName } from "../core/names";
import {
  EntityRef,
  EpisodeId,
  isoDate,
  isoDateTime,
  MadeBy,
  PersonRef,
  slug,
  UnitId,
} from "./fields";
import { MemoryType } from "./unit";

// Memory's observations (memory/observations/, docs/SCHEMA.md) and what reads or corrects them: extractions,
// supersessions, corrections, inferred people and repos, imports, closeness.

/** How a claim was said: as true, as settled for later, about a third person, or only conditionally (a hypothesis, a quote). */
export const Modality = z.enum(["fact", "plan", "reported", "conditional"]);

const Correcting = {
  at: isoDateTime,
  note: z.string().optional(),
  schemaVersion: z.literal(1),
};

export const ObservationId = z.string().regex(/^obs_[0-9a-f]{12}$/);

/** Inferred people below this confidence are remembered but not linked to; the next day that sees them asks again. */
export const INFERRED_USE_AT = 0.5;

/** The people outside the directory (inferred, or named by his Contacts) not folded into another (`foldsOf`): one id per person. */
export const unfoldedOf = <P extends { id: string }>(
  people: P[],
  canon: (ref: string) => string
) => people.filter((p) => canon(`person:${p.id}`) === `person:${p.id}`);

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
    importance: z.int().min(1).max(3),
    madeBy: MadeBy.extend({ unitHash: z.string() }).strict(),
    modality: Modality.optional(),
    /** Verbatim from the source text the model read; code checked it is there. */
    quote: z.string().min(1).max(600),
    schemaVersion: z.literal(1),
    source: z
      .object({
        channel: SourceName,
        // lifelog: jobId:turnIndex@capturedAt; chats and mail: the message id.
        ref: z.string().min(1),
      })
      .strict(),
    /** Who said or wrote the cited line: person:<slug>, unknown:<label>, or agent:<name> (an agent's report, never a person). */
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
    /** Not read: a unit read before that its latest verdict no longer keeps; its facts are replaced by none. */
    unkept: z.literal(true).optional(),
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
 * by extraction, when later lines of an episode show it is no longer true, or (before memory-extract.v3) while
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

/** How close someone is to the owner, in his personal life or his work: `faded` was close, not any more. */
export const ClosenessLevel = z.enum([
  "inner",
  "regular",
  "acquaintance",
  "faded",
]);

export type ClosenessLevel = z.infer<typeof ClosenessLevel>;

/** A page's sections, in page order (`SECTIONS`, page-format.ts): views and health on the owner's page only, bond on a close person's (`layoutOf`). */
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
 * everywhere); `outdated` says observations were true and are not anymore (a promise kept, a to-do done): each is
 * retired as history, by itself; `keep-mine` is a page line that stays as written; `this-is` says a handle or name is a person,
 * `not-this-person` that it is not, `same-person` that two person refs are one (`from` folds into `to`); `reread`
 * says units were read wrong (a fact under the wrong person, say): each is extracted again when its day is next read.
 */
export const Correction = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...Correcting,
        kind: z.enum(["wrong", "not-important"]),
        // Observations (obs_…) and, from 18 Oct, episodes (ep_…).
        observations: z.array(z.union([ObservationId, EpisodeId])).min(1),
        page: EntityRef.optional(),
      })
      .strict(),
    z
      .object({
        ...Correcting,
        kind: z.literal("outdated"),
        observations: z.array(ObservationId).min(1),
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
        personal: ClosenessLevel.optional(),
        work: ClosenessLevel.optional(),
      })
      .strict(),
  ])
  .refine((c) => c.kind !== "closeness" || !!(c.personal || c.work), {
    message: "a closeness correction names a personal or a work level",
  });

export type Correction = z.infer<typeof Correction>;

/** What a person outside the directory goes by: handles (a phone, an email, a network's id) or names, at least one. */
const Surfaces = z.array(z.string().min(1)).min(1);

/** The id prefix of people Life inferred; truth ids never start with it, so the two never collide. */
export const INFERRED_PREFIX = "inf_";

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
    id: z.string().regex(/^inf_[a-z0-9-]+$/),
    madeBy: MadeBy,
    /** A name when the messages give one, else a short description ("the plumber changing the shop sink"). */
    name: z.string().min(1),
    /**
     * The person in truth/ it is, when the call judged it is them (used as them from INFERRED_USE_AT, `foldsOf`); null
     * when it judged no one there is; absent on guesses made before the call could link, asked once more (`answeredBy`).
     */
    person: PersonRef.nullable().optional(),
    project: slug.nullable(),
    relation: z.string().min(1),
    schemaVersion: z.literal(1),
    /** Handles (phone, WhatsApp id, a network's id) or names this person goes by. */
    surfaces: Surfaces,
  })
  .strict();

export type InferredPerson = z.infer<typeof InferredPerson>;

/** The id prefix of the people his Contacts name (`ContactPerson`); truth ids never start with it either. */
export const CONTACT_PREFIX = "con_";

/**
 * memory/people-contacts.jsonl: a card of his Contacts whose handle appears in his messages, as Contacts name it. Written
 * by code (the night's `writeContactPeople`), append-only: a card's latest line gives its name, and its surfaces only
 * grow. Who it is does not rest on the card any more: a card he deletes keeps its person (his answer, 12 Nov 2026).
 * Used below truth/ and above Life's own guesses (`readingOf`): his Contacts are his word on who a number is.
 */
export const ContactPerson = z
  .object({
    at: isoDateTime,
    /** The card's own id in Contacts; the person's id is derived from it (`contactIdOf`), never from a name. */
    card: z.string().min(1),
    name: z.string().min(1),
    schemaVersion: z.literal(1),
    /** The card's phones and emails, as written. */
    surfaces: Surfaces,
  })
  .strict();
export type ContactPerson = z.infer<typeof ContactPerson>;

/** A contact person's id: the prefix and a digest of its card's id. */
export const contactIdOf = (card: string) =>
  `${CONTACT_PREFIX}${digest("sha1", card, 12)}`;

/**
 * memory/repos-inferred.jsonl: which project a code repo belongs to, as Life guesses (folder name under ~/Work, or
 * owner/name for a repo only on GitHub). Model-owned and append-only (the latest record for a repo wins); used at once
 * below truth/ (`Project.repos`) and never written into it. A repo that fits no project may carry the name and purpose
 * of a project the owner might want (`newProject`: "Cove: macOS call recorder"); it becomes one only when he says so.
 */
export const InferredRepo = z
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

export type InferredRepo = z.infer<typeof InferredRepo>;

/**
 * memory/imported.jsonl: whether a conversation of his claude.ai or ChatGPT export is about his life (people, plans,
 * decisions, himself) or only work with the assistant, as the fast model judged it from his pruned messages
 * (`memory/imports.ts`). Model-owned and append-only, the latest line per conversation wins; only kept ones are read
 * (`sources/assistants.ts`).
 */
export const Imported = z
  .object({
    at: isoDateTime,
    conversation: z.string().min(1),
    /** A hash of the conversation's latest version as the model reads it (its title and the start of his kept messages), before twins in other conversations are dropped; lines from before have none. */
    hash: z.string().optional(),
    keep: z.boolean(),
    madeBy: MadeBy,
    schemaVersion: z.literal(1),
    why: z.string().min(1).max(300),
  })
  .strict();

export type Imported = z.infer<typeof Imported>;

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
    personal: ClosenessLevel,
    schemaVersion: z.literal(1),
    service: z.boolean(),
    why: z.string().min(1).max(300),
    work: ClosenessLevel,
  })
  .strict();

export type Closeness = z.infer<typeof Closeness>;

/** Someone outside the directory, as every listing of people needs them: a contact person, or one Life inferred. */
export interface PersonOutsideDirectory {
  /** A guess's confidence; a contact person has none. */
  confidence?: number;
  id: string;
  kind: "contact" | "inferred";
  name: string;
  relation: string;
  surfaces: string[];
}

/** What Life says of someone it knows only from his Contacts: a card names them, nothing tells what they are to him. */
export const IN_CONTACTS = "in his Contacts";

/** Everyone outside the directory, folded or not (`unfoldedOf` for one id per person): the contact people, then the inferred. */
export const peopleOutsideDirectoryOf = (
  contacts: { id: string; name: string; surfaces: string[] }[],
  inferred: InferredPerson[]
): PersonOutsideDirectory[] => [
  ...contacts.map((c) => ({
    id: c.id,
    kind: "contact" as const,
    name: c.name,
    relation: IN_CONTACTS,
    surfaces: c.surfaces,
  })),
  ...inferred.map((p) => ({
    confidence: p.confidence,
    id: p.id,
    kind: "inferred" as const,
    name: p.name,
    relation: p.relation,
    surfaces: p.surfaces,
  })),
];
