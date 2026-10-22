import { closeSync, existsSync, openSync } from "node:fs";
import { WINDOWS } from "../core/platform";
import { agentName, settings } from "../core/settings";
import {
  AGENT_WORD,
  type Person,
  type SourceEvent,
  type Unit,
} from "../schema";
import { newestAgent, readAgent } from "./agent";
import { archiveDb } from "./archived";
import {
  FORMATS,
  importOf,
  newestAssistant,
  readAssistant,
} from "./assistants";
import { copyBeeper, newestBeeper, readBeeper } from "./beeper";
import { newestCommit, type RepoMap, readGit } from "./git";
import {
  DB,
  handleOf,
  isImessageGroup,
  newestImessage,
  readImessage,
} from "./imessage";
import { lifelogMissing } from "./lifelog";
import { mailRoot, newestMail, readMail } from "./mail";
import { copyNotes, newestNote, readNotes } from "./notes";
import {
  copyWhatsapp,
  isWhatsappGroup,
  newestWhatsapp,
  phoneOf,
  readWhatsapp,
} from "./whatsapp";

// The registry: what Life knows about each source, in one descriptor. Code asks a source's kind or what it can do (a
// field here), never its name; the tables of sources are derived from it (`tablesOf`, units.ts).

type SourceName = Unit["source"];

/** A source's newest item, for the status plate: when it came, his words in it, by part. */
export interface Newest {
  at: string | null;
  /** More lines for its card (a repo's name, how many committed today). */
  facts?: { label: string; value: string }[];
  /** Each part's newest (Beeper's networks). */
  parts?: { at: string; label: string }[];
  /** His words in it: the app shows them only while Show content is on. */
  words?: string[];
}

const HOUR = 3_600_000;

/** `why`, unless this process can open `path` (macOS refuses it without Full Disk Access). */
function unreadable(path: string, why: string) {
  try {
    closeSync(openSync(path, "r"));
  } catch {
    return why;
  }
}
export const FULL_DISK = "Full Disk Access for Life";
/**
 * An app's own store the archive copies (`archive.ts`), because the app wipes what is deleted. `app` writes it and is
 * kept running: closed, it receives nothing. `copy` copies what is new and says how many versions; `copies` is the
 * table each copy is a row of, `media` the column of its `deleted` view that names a copied file.
 */
export interface AppStore {
  app: string;
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
  /** Its newest item (the status plate's card); a voice source's is lifelog's to tell. */
  newest?: () => Newest | Promise<Newest>;
  /** How many days back `search` and `chats --who` read its messages; without it, `search` does not read them. */
  searchDays?: number;
  /** How long it may stay silent before its card turns amber (`toneOf`, plate.ts). */
  silentAfter: number;
} & (
  | {
      /**
       * notes: his own writing, no one else's words (Apple Notes, his messages to AI assistants); agent: what his agents
       * report they did, evidence of it, never anyone's words.
       */
      kind: "agent" | "chat" | "mail" | "notes";
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
const LISTED: Descriptor[] = [
  // The Pendant: expected to hear him between 08:00 and 01:00 only (`waking`, plate.ts).
  {
    kind: "voice",
    label: "Pendant",
    missing: lifelogMissing,
    name: "lifelog",
    silentAfter: 6 * HOUR,
  },
  {
    chatDays: 7,
    group: isImessageGroup,
    handleOf,
    kind: "chat",
    label: "iMessage",
    macOnly: true,
    missing: () => unreadable(DB, FULL_DISK),
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
    macOnly: true,
    name: "whatsapp",
    newest: newestWhatsapp,
    read: readWhatsapp,
    searchDays: 90,
    silentAfter: 24 * HOUR,
    store: {
      app: "WhatsApp",
      copies: "messages",
      copy: copyWhatsapp,
      media: "media",
    },
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
    store: {
      app: "Beeper Desktop",
      copies: "messages",
      copy: copyBeeper,
      media: "''",
    },
  },
  {
    kind: "mail",
    label: "Mail",
    macOnly: true,
    missing: () => {
      try {
        mailRoot();
      } catch {
        return FULL_DISK;
      }
    },
    name: "mail",
    newest: newestMail,
    read: readMail,
    searchDays: 90,
    silentAfter: 12 * HOUR,
  },
  {
    kind: "notes",
    label: "Notes",
    macOnly: true,
    name: "notes",
    newest: newestNote,
    read: readNotes,
    // ponytail: each search reads every note version (1,500 in 15 ms, a whole search 150 ms, Oct 2026); index their
    // text in index.sqlite if that grows slow.
    searchDays: Number.POSITIVE_INFINITY,
    silentAfter: 7 * 24 * HOUR,
    store: {
      app: "Notes",
      copies: "versions",
      copy: copyNotes,
      media: "''",
    },
  },
  // His claude.ai and ChatGPT history, imported once (memory/imports.ts): it never gets new items, so its card is never
  // amber; its newest is his newest imported message. ponytail: search reads every pruned message (the export parsed once per process,
  // every sweep included); index them in index.sqlite if that grows slow.
  ...(["claude", "chatgpt"] as const).map(
    (name): Descriptor => ({
      imported: true,
      kind: "notes",
      label: FORMATS[name].label,
      missing: () => (existsSync(importOf(name)) ? undefined : "not imported"),
      name,
      newest: () => newestAssistant(name),
      read: readAssistant(name),
      searchDays: Number.POSITIVE_INFINITY,
      silentAfter: Number.POSITIVE_INFINITY,
    })
  ),
  // The agent's done tasks (decision 14, 21 Oct): Life's own ledger, never silent by its own fault.
  {
    kind: "agent",
    label: agentName(),
    name: AGENT_WORD,
    newest: newestAgent,
    read: readAgent,
    silentAfter: Number.POSITIVE_INFINITY,
  },
  {
    kind: "repo",
    label: "Git",
    missing: () => (settings().repos ? undefined : "no repos folder set"),
    name: "git",
    newest: newestCommit,
    read: (since, { me, repos }) => readGit(since, repos, me),
    silentAfter: 72 * HOUR,
  },
];

/** Whether its app is on this system: a Mac-only one only on the Mac. */
const appHere = (s: Descriptor) => !(s.macOnly && WINDOWS);

export const SOURCES = LISTED.map((s): Descriptor => {
  if (!(s.store || appHere(s))) {
    return { ...s, missing: () => "macOS only" };
  }
  // An archived source is there once the archive has copied its store.
  return s.store
    ? {
        ...s,
        missing: () =>
          unreadable(archiveDb(s.name), `${s.label} not archived yet`),
      }
    : s;
});

/** The sources he turned on (the `sources` setting), in cut order: no other is read, searched or shown. */
export const enabledSources = <T extends Descriptor>(
  all: T[] = SOURCES as T[],
  on = settings().sources
) => all.filter((s) => on.includes(s.name));

export type Archived = Descriptor & { store: AppStore };
/**
 * The sources whose app store an archive holds, on any system: an export carries them all, and an archive moved from
 * the Mac keeps its deleted messages.
 */
export const ARCHIVED = SOURCES.filter((s): s is Archived => Boolean(s.store));
/** The archived sources he turned on that this system copies: no other app is opened, and a Mac-only one only on the Mac. */
export const keptStores = (on = settings().sources) =>
  enabledSources(ARCHIVED, on).filter(appHere);

/**
 * The sources he turned on that can be read now. One that can't (`missing`: not set up, or its access gone) is left out,
 * its units and its days' moments kept, shown as "can't read",
 * so it never fails a night (`gather` logs why); one that can be read and then throws still does (`safely`).
 */
export const readySources = (all = enabledSources()) =>
  all.filter((s) => !s.missing?.());

/** Whether a voice source is on and set up: what the watcher listens to, and what voice search and `day` read. */
export const listening = () => readySources().some((s) => s.kind === "voice");

const BY_NAME = new Map(SOURCES.map((s) => [s.name, s]));
/** A stored source name's descriptor: every name has one (`index.test.ts`). */
export const sourceOf = (name: SourceName) => BY_NAME.get(name) as Descriptor;
export const kindOf = (name: SourceName) => sourceOf(name).kind;
/** Whether a chat is 1:1: not a group by its id (its source's `group`), or, for a source that cannot tell, one other sender at most. */
export const isDirect = (name: SourceName, chat: string, others: number) => {
  const { group } = sourceOf(name);
  return group ? !group(chat) : others <= 1;
};
