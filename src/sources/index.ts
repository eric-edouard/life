import type { Person, SourceEvent, Unit } from "../schema";
import { FORMATS, newestAssistant, readAssistant } from "./assistants";
import { newestBeeper, readBeeper } from "./beeper";
import { newestCommit, type RepoMap, readGit } from "./git";
import {
  handleOf,
  isImessageGroup,
  newestImessage,
  readImessage,
} from "./imessage";
import { newestMail, readMail } from "./mail";
import { newestNote, readNotes } from "./notes";
import {
  isWhatsappGroup,
  newestWhatsapp,
  phoneOf,
  readWhatsapp,
} from "./whatsapp";

// The registry: what Life knows about each source, in one descriptor. Code asks a source's kind or what it can do (a
// field here), never its name; the tables of sources are derived from it (`tablesOf`, units.ts).

type SourceName = Unit["source"];

/** A source's newest item, for the status page: when it came, his words in it, by part. */
export interface Newest {
  at: string | null;
  /** More lines for its card (a repo's name, how many committed today). */
  facts?: { label: string; value: string }[];
  /** Each part's newest (Beeper's networks). */
  parts?: { at: string; label: string }[];
  /** His words in it: the status page hides them in privacy mode and never sends them off the Mac. */
  words?: string[];
}

const HOUR = 3_600_000;

export type Descriptor = {
  /** How many days back `chats --chat` reads it. */
  chatDays?: number;
  /** Whether a chat is a group, told by its id: then every other chat is 1:1, whatever handles one person wrote from. */
  group?: (chat: string) => boolean;
  /** The handle a 1:1 chat's key holds (who wrote a fact that predates `speakerFrom`). */
  handleOf?: (key: string) => string | undefined;
  /** Imported once: its conversations' units are read only once the import step kept them (the `not-kept` rule). */
  imported?: boolean;
  /** What he calls it. */
  label: string;
  name: SourceName;
  /** Its newest item (the status page's card); a voice source's is lifelog's to tell. */
  newest?: () => Newest | Promise<Newest>;
  /** How many days back `search` and `chats --who` read its messages; without it, `search` does not read them. */
  searchDays?: number;
  /** How long it may stay silent before its card turns amber (`toneOf`, plate.ts). */
  silentAfter: number;
} & (
  | {
      /** notes: his own writing, no one else's words (Apple Notes, his messages to AI assistants). */
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

/**
 * Every source, in the order units are cut (`gather` cuts lifelog's from the watcher's store first, then each other
 * source's in this order): of two with the same content, the first stays and the second is dropped as a duplicate.
 */
export const SOURCES: Descriptor[] = [
  // The Pendant: expected to hear him between 08:00 and 01:00 only (`waking`, plate.ts).
  { kind: "voice", label: "Pendant", name: "lifelog", silentAfter: 6 * HOUR },
  {
    chatDays: 7,
    group: isImessageGroup,
    handleOf,
    kind: "chat",
    label: "iMessage",
    name: "imessage",
    newest: newestImessage,
    read: readImessage,
    searchDays: 90,
    silentAfter: 24 * HOUR,
  },
  {
    chatDays: 7,
    group: isWhatsappGroup,
    handleOf: phoneOf,
    kind: "chat",
    label: "WhatsApp",
    name: "whatsapp",
    newest: newestWhatsapp,
    read: readWhatsapp,
    searchDays: 90,
    silentAfter: 24 * HOUR,
  },
  {
    chatDays: 7,
    kind: "chat",
    label: "Beeper",
    name: "beeper",
    newest: newestBeeper,
    read: readBeeper,
    searchDays: 90,
    silentAfter: 72 * HOUR,
  },
  {
    kind: "mail",
    label: "Mail",
    name: "mail",
    newest: newestMail,
    read: readMail,
    searchDays: 90,
    silentAfter: 12 * HOUR,
  },
  {
    kind: "notes",
    label: "Notes",
    name: "notes",
    newest: newestNote,
    read: readNotes,
    // ponytail: each search reads every note version (1,500 in 15 ms, a whole search 150 ms, Oct 2026); index their
    // text in index.sqlite if that grows slow.
    searchDays: Number.POSITIVE_INFINITY,
    silentAfter: 7 * 24 * HOUR,
  },
  // His claude.ai and ChatGPT history, imported once (memory/imports.ts): it never gets new items, so its card is never
  // amber; its newest is his newest imported message. ponytail: search reads every pruned message (the export parsed once per process,
  // every sweep included); index them in index.sqlite if that grows slow.
  ...(["claude", "chatgpt"] as const).map(
    (name): Descriptor => ({
      imported: true,
      kind: "notes",
      label: FORMATS[name].label,
      name,
      newest: () => newestAssistant(name),
      read: readAssistant(name),
      searchDays: Number.POSITIVE_INFINITY,
      silentAfter: Number.POSITIVE_INFINITY,
    })
  ),
  {
    kind: "repo",
    label: "Git",
    name: "git",
    newest: newestCommit,
    read: (since, { me, repos }) => readGit(since, repos, me),
    silentAfter: 72 * HOUR,
  },
];

const BY_NAME = new Map(SOURCES.map((s) => [s.name, s]));
/** A stored source name's descriptor: every name has one (`index.test.ts`). */
export const sourceOf = (name: SourceName) => BY_NAME.get(name) as Descriptor;
export const kindOf = (name: SourceName) => sourceOf(name).kind;
