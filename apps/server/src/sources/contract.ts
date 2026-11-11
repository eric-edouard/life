import { existsSync } from "node:fs";
import type { SourceName } from "../core/names";
import type { InferredRepo } from "../records/observation";
import type { SourceEvent, SourceFile } from "../records/source";
import type { Person } from "../records/truth";

// The source contract: what Life knows about each source, in one descriptor. Each reader gives its parts; the registry
// (`memory/sources.ts`) lists them. Code asks a source's kind or what it can do, never its name.

/** A source's newest item, for the status snapshot: when it came, his words in it, by part. */
export interface Newest {
  at: string | null;
  /** More lines for its card (a repo's name, how many committed today). */
  facts?: { label: string; value: string }[];
  /** Each part's newest (the bridged networks): the quietest one decides the card's colour. */
  parts?: { at: string; label: string }[];
  /** His words in it: the app shows them only while Show content is on. */
  words?: string[];
}

/**
 * An app's own store the archive copies (`archive.ts`), because the app wipes what is deleted or ages out. `app` writes
 * it and is kept running: closed, it receives nothing. `copy` copies what is new and says how many versions; `copies` is
 * the table each copy is a row of. `deleted`: what the app deletes is kept in the archive's `deleted` view, `media` its
 * column that names a copied file.
 */
export interface AppStore {
  /** The app that writes it, kept open; none for a bridge (the bridges' one job keeps it running). Read each time: a bridged network's is Beeper Desktop while Beeper copies it. */
  app?: string;
  copies: string;
  /** Copies what is new into the archive (its count, for tests: Life reads none). */
  copy: () => void;
  deleted?: { media?: string };
}
/** A message as its store first wrote it (`incoming`): its row there, its id as `read` gives it and its time. */
export interface NewRow {
  at: string;
  id: string;
  row: number;
}

export type Descriptor = {
  /** How many days back `chats --chat` reads it. */
  chatDays?: number;
  /** Whether a chat is a group, told by its id: then every other chat is 1:1, whatever handles one person wrote from. */
  group?: (chat: string) => boolean;
  /** The handle a 1:1 chat's key holds (who wrote a fact that predates `speakerFrom`). */
  handleOf?: (key: string) => string | undefined;
  /**
   * For a chat or mail source with an ordered store: the messages its store first wrote from row `from` on (none
   * without one), oldest row first, and one past its last row (`events.ts`). An edit, a delete or a second copy of a message is not a new
   * message. Without it, the source has no events.
   */
  incoming?: (from?: number) => { end: number; rows: NewRow[] };
  /** What keeps it from being read now (a permission, an app never opened, a part not set up); nothing when it can be. */
  missing?: () => string | undefined;
  /** Imported from exports: its conversations' units are read only once the import step kept them (the `not-kept` rule). */
  imported?: boolean;
  /**
   * Its app exists only on the Mac (`platform.ts`): elsewhere it is never read, or, with a `store`, read from the
   * archive's copy and never copied.
   */
  macOnly?: true;
  /** What he calls it. */
  label: string;
  /** The app store the archive keeps a copy of; its units are read from that copy. */
  store?: AppStore;
  name: SourceName;
  /** Its newest item (the status snapshot's card); a voice source's is lifelog's to tell. */
  newest?: () => Newest | Promise<Newest>;
  /** Earliest stored instant, read from source metadata without reading message text. */
  earliest?: () => string | null;
  /** How long it may stay silent before its card turns amber (`toneOf`, snapshot.ts). */
  silentAfter: number;
} & (
  | {
      /**
       * own_writing: his own writing, no one else's words (Apple Notes, his messages to AI assistants); agent: what his agents
       * report they did, evidence of it, never anyone's words; screen: the time he spent in each app and website, as his
       * devices record it; physical: what his devices measure of his body; photos: his library, as Apple's analysis and he
       * described each photo.
       */
      kind:
        | "agent"
        | "chat"
        | "mail"
        | "own_writing"
        | "screen"
        | "physical"
        | "photos";
      /** Called with `since` alone, so a reader may take its own optional arguments. */
      read: (since: Date, before?: Date) => SourceEvent[];
    }
  /** His commits (whose repos are whose and who he is from his map): one unit per repo and day, never extracted. */
  | {
      kind: "repo";
      read: (
        since: Date,
        map: { me: Person; repos: RepoMap },
        before?: Date
      ) => SourceEvent[];
    }
  /** Recorded conversations: their units come from the watcher's store, their words from lifelog. */
  | { kind: "voice" }
);

/** Activity: what his devices record (commits, Screen Time, body measurements, photos), never someone else's words (a photo's caption is his): never extracted, importance 1 at most. */
export const isActivity = (kind: Descriptor["kind"]) =>
  kind === "repo" ||
  kind === "screen" ||
  kind === "physical" ||
  kind === "photos";

/** Whether an item is in a `read`'s window: from `since` on, before `before`. */
export const isWithin = (since: Date, before?: Date) => {
  const from = since.toISOString();
  const to = before?.toISOString();
  return (item: { at: string }) => item.at >= from && (!to || item.at < to);
};

/** Which project and area a repo belongs to: his map (`Project.repos`), else what Life inferred (`inferred`, set when it is one). */
export interface Placement {
  area: string | null;
  inferred?: InferredRepo;
  project: string | null;
}
export type RepoMap = Map<string, Placement>;
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
