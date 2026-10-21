import type { Person, SourceEvent, Unit } from "../schema";
import { readBeeper } from "./beeper";
import { type RepoMap, readGit } from "./git";
import { isGroup, readImessage } from "./imessage";
import { readMail } from "./mail";
import { readNotes } from "./notes";
import { phoneOf, readWhatsapp } from "./whatsapp";

// The registry: what Life knows about each source, in one descriptor. Code asks a source's kind or what it can do (a
// field here), never its name; the tables of sources are derived from it (`tablesOf`, units.ts).

type SourceName = Unit["source"];

export type Descriptor = {
  /** How many days back `chats --chat` reads it. */
  chatDays?: number;
  /** Whether a chat is a group, told by its id: then every other chat is 1:1, whatever handles one person wrote from. */
  group?: (chat: string) => boolean;
  /** The handle a 1:1 chat's key holds (who wrote a fact that predates `speakerFrom`). */
  handleOf?: (key: string) => string | undefined;
  name: SourceName;
  /** How many days back `search` reads its messages; without, `search` does not read them. */
  searchDays?: number;
} & (
  | {
      kind: "chat" | "mail" | "notes";
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

// A 1:1 iMessage chat's key is its handle (a number or an address).
// ponytail: WhatsApp's `@lid` 1:1 chats and Beeper have no handle in their key, so their older facts keep their author.
const IMESSAGE_HANDLE = /^(\+\d+|[^@\s]+@[^@\s]+)$/;

/**
 * Every source, in the order units are cut (`gather` cuts lifelog's from the watcher's store first, then each other
 * source's in this order): of two with the same content, the first stays and the second is dropped as a duplicate.
 */
export const SOURCES: Descriptor[] = [
  { kind: "voice", name: "lifelog" },
  {
    chatDays: 7,
    group: isGroup,
    handleOf: (key) => (IMESSAGE_HANDLE.test(key) ? key : undefined),
    kind: "chat",
    name: "imessage",
    read: readImessage,
    searchDays: 90,
  },
  {
    chatDays: 7,
    group: (chat) => chat.endsWith("@g.us"),
    handleOf: phoneOf,
    kind: "chat",
    name: "whatsapp",
    read: readWhatsapp,
    searchDays: 90,
  },
  {
    chatDays: 7,
    kind: "chat",
    name: "beeper",
    read: readBeeper,
    searchDays: 90,
  },
  { kind: "mail", name: "mail", read: readMail },
  {
    kind: "notes",
    name: "notes",
    read: readNotes,
    // ponytail: each search reads every note version (1,500 in 15 ms, a whole search 150 ms, Oct 2026); index their
    // text in index.sqlite if that grows slow.
    searchDays: Number.POSITIVE_INFINITY,
  },
  {
    kind: "repo",
    name: "git",
    read: (since, { me, repos }) => readGit(since, repos, me),
  },
];

const BY_NAME = new Map(SOURCES.map((s) => [s.name, s]));
/** A stored source name's descriptor: every name has one (`index.test.ts`). */
export const sourceOf = (name: SourceName) => BY_NAME.get(name) as Descriptor;
export const kindOf = (name: SourceName) => sourceOf(name).kind;
