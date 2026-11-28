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
  facts?: { at?: string; label: string; value: string }[];
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
  /** Copies what is new into the archive (its count, for tests: Life reads none). A copy over the network is async: the archive never waits on it to copy the other stores. */
  copy: () => unknown;
  deleted?: { media?: string };
}
/**
 * A card's draft as a send path takes it: `text`, a `file` (its bytes, checked against the digest the card showed),
 * `onMessage` (a message's id as `read` gives it: replied to, or with `reaction` reacted to), `mentions` (senders as
 * `read` gives them, each an `@name` of `text`).
 */
export interface Outgoing {
  cc?: string;
  /** A mail's `to` is its addresses, and its `chat`. */
  chat: string;
  file?: { bytes: Uint8Array; mime: string; name: string };
  from?: string;
  mentions?: { name: string; sender: string }[];
  onMessage?: string;
  reaction?: string;
  subject?: string;
  text?: string;
  to?: string;
}

/** What a chat takes besides text (`chat-takes.ts`): `reaction` true, or only these emoji. */
export interface ChatTakes {
  file: boolean;
  mentions: boolean;
  reaction: boolean | string[];
  reply: boolean;
}

/** How one source sends a card's draft (.claude/rules/acts-and-sends.md, "Life sends only…"): asked when the card is, run on his answer. */
export interface SendPath {
  /** Why it can't send now (a bridge not added, not linked, not answering); none when it can. */
  block: () => Promise<string | undefined>;
  /** Of these chats, the ones it can send into today. */
  holds: (chats: string[]) => string[];
  /** How long a send of this draft may take, at most (its own waits added up): the app draws it. */
  limitMs: (draft: Outgoing) => number;
  /** For a chat it can open (a new 1:1 chat, a new issue): its name there, none when it has no such chat. */
  opens?: (chat: string) => Promise<string | undefined>;
  /** How `to` names a chat it can open, for the agent asking (with `opens`). */
  opensHint?: string;
  /** A chat it opens takes the draft's `subject` (a new issue's title). */
  opensWithSubject?: true;
  /** How many people a chat holds, him included, as its network keeps them (a draft's "N people"); none when it can't say. */
  people?: (chat: string) => number | undefined;
  /** What of this draft its chat can't take (what `takes` says no to, by `takesProblemOf`, then its own limits: a file of this kind or size…), asked again just before the send; none when it takes all. */
  refusal: (draft: Outgoing) => Promise<string | undefined>;
  /** Sends once per `txn`; the sent message's id once confirmed (Life's own event id where it knows it). `onHanded` is called when the network or the app has taken it, before the wait to see it. Throws `not sent: …` (nothing went) or `may have gone: …`. */
  send: (
    draft: Outgoing,
    txn: string,
    onHanded?: () => void
  ) => Promise<string>;
  /** What a chat takes besides text: the one source of `refusal`'s reply, reaction, mention and file rules, and what `read_chats` tells an agent. */
  takes: (chat: string) => ChatTakes;
  /** His Undo of a send (`unsendDraft`): deletes message `id` for everyone, resolving once its network confirms; throws why not. With `unsendLine`; none where nothing can be unsent (iMessage, mail). */
  unsend?: (chat: string, id: string) => Promise<void>;
  /** What the other side will see once `unsend` deletes a message sent at `sentAt`; none when the chat allows no delete now (too old, or never). */
  unsendLine?: (chat: string, sentAt: string, now: Date) => string | undefined;
}

/** A message as its store first wrote it (`incoming`): its row there, its id as `read` gives it and its time. */
export interface NewRow {
  at: string;
  id: string;
  row: number;
}

/** A picture someone shows on a source (a person picture, `docs/glossary.md`), by the handles Life reads them as. */
export interface Picture {
  bytes: Uint8Array;
  handles: string[];
}

/** When a message was written, by its id: its versions' first and last instants, which its source's `read` then reads. */
export interface MessageAt {
  first: string;
  last: string;
}

export type Descriptor = {
  /** How many days back `chats --chat` reads it. */
  chatDays?: number;
  /** Whether a chat is a group, told by its id: then every other chat is 1:1, whatever handles one person wrote from. */
  group?: (chat: string) => boolean;
  /** The handle a 1:1 chat's key holds (who wrote a fact that predates `speakerFrom`). */
  handleOf?: (key: string) => string | undefined;
  /** The network's own link that opens a 1:1 chat with a handle (WhatsApp's `wa.me`, Messages' `sms:`, Telegram's `t.me`, Mail's `mailto:`); none for a handle it can't open, or a network without one. */
  chatLinkOf?: (handle: string) => string | undefined;
  /**
   * For a chat or mail source with an ordered store: the messages its store first wrote from row `from` on (none
   * without one), oldest row first, and one past its last row (`events.ts`). An edit, a delete or a second copy of a message is not a new
   * message. Without it, the source has no events.
   */
  incoming?: (from?: number) => { end: number; rows: NewRow[] };
  /** For a chat or mail source whose store finds a message by its id (as `read` gives it), whatever its age: when it was written. */
  messageAt?: (id: string) => MessageAt | undefined;
  /**
   * It records without him doing anything (a chat archive, mail, the pendant): only such a source covers a day
   * (`memory/coverage.ts`). One that records only when he acts (a photo, a commit, a note) covers nothing.
   */
  capturesOnItsOwn?: true;
  /** What keeps it from being read now (a permission, an app never opened, a part not set up); nothing when it can be. */
  missing?: () => string | undefined;
  /** Its threads are a work tracker's (issues, pull requests), not a conversation: never an arrival; an agent waits on them instead. */
  isWorkTracker?: true;
  /** Imported from exports: its conversations' units are read only once the import step kept them (the `not-kept` rule). */
  imported?: boolean;
  /**
   * Its app exists only on the Mac (`platform.ts`): elsewhere it is never read, or, with a `store`, read from the
   * archive's copy and never copied.
   */
  macOnly?: true;
  /** What he calls it. */
  label: string;
  /**
   * Its senders are phones or emails however written, a bare number too (Messages, the Phone app; Photos' pictured
   * people, a Contacts field or a name): read through their contact key (`writtenContactKeyOf`). Without it a bare
   * number is a network's id, read exactly as written.
   */
  hasPhoneHandles?: true;
  /** The pictures its people show (a bridge's ghosts' avatars, the photos shared through Messages); none without. */
  pictures?: () => Picture[];
  /** How a card's draft goes into one of its chats (`memory/draft-send.ts`); a source without it sends nothing. */
  send?: SendPath;
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
  /** His commits (whose repos are whose and who he is from his directory): one unit per repo and day, never extracted. */
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

/** Which project and area a repo belongs to: his directory (`Project.repos`), else what Life inferred (`inferred`, set when it is one). */
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
