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
  /** Each part's newest (Beeper's networks): the quietest one decides the card's colour. */
  parts?: { at: string; label: string }[];
  /** His words in it: the app shows them only while Show content is on. */
  words?: string[];
}

/**
 * An app's own store the archive copies (`archive.ts`), because the app wipes what is deleted. `app` writes it and is
 * kept running: closed, it receives nothing. `copy` copies what is new and says how many versions; `copies` is the
 * table each copy is a row of, `media` the column of its `deleted` view that names a copied file.
 */
export interface AppStore {
  /** The app that writes it, kept open; none for a bridge (its LaunchAgent keeps it running). */
  app?: string;
  copies: string;
  copy: () => number;
  media: string;
}
export type Descriptor = {
  /** How many days back `chats --chat` reads it. */
  chatDays?: number;
  /** Whether a chat is a group, told by its id: then every other chat is 1:1, whatever handles one person wrote from. */
  group?: (chat: string) => boolean;
  /** The handle a 1:1 chat's key holds (who wrote a fact that predates `speakerFrom`). */
  handleOf?: (key: string) => string | undefined;
  /** What keeps it from being read now (a permission, an app never opened, a part not set up); nothing when it can be. */
  missing?: () => string | undefined;
  /** Imported once: its conversations' units are read only once the import step kept them (the `not-kept` rule). */
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
  /**
   * Sending as him: `deliver` puts his text into one of its chats (`host/send.ts`, the only caller: his answered
   * decision; `txn` makes it once on the network's side too); `blocked` says, from the network itself, why a send can't
   * go now (the Sends card), none when it can.
   */
  send?: {
    blocked: () => Promise<string | undefined>;
    deliver: (chat: string, text: string, txn: string) => Promise<void>;
  };
  /**
   * For a chat source with no archive copy (iMessage): the chats someone else wrote in after its cursor, and the new
   * cursor (none at first: only the cursor). The archive's message event reads it each pass.
   */
  incoming?: (after: number | undefined) => { chats: string[]; last: number };
  /** Its newest item (the status snapshot's card); a voice source's is lifelog's to tell. */
  newest?: () => Newest | Promise<Newest>;
  /** How many days back `search` and `chats --who` read its messages; without it, `search` does not read them. */
  searchDays?: number;
  /** How long it may stay silent before its card turns amber (`toneOf`, snapshot.ts). */
  silentAfter: number;
} & (
  | {
      /**
       * own_writing: his own writing, no one else's words (Apple Notes, his messages to AI assistants); agent: what his agents
       * report they did, evidence of it, never anyone's words.
       */
      kind: "agent" | "chat" | "mail" | "own_writing";
      /** Called with `since` alone, so a reader may take its own optional arguments. */
      read: (since: Date) => SourceEvent[];
    }
  /** His commits (whose repos are whose and who he is from his map): one unit per repo and day, never extracted. */
  | {
      kind: "repo";
      read: (since: Date, map: { me: Person; repos: RepoMap }) => SourceEvent[];
    }
  /** Recorded conversations: their units come from the watcher's store, their words from lifelog. */
  | { kind: "voice" }
);

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
