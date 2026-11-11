import { closeSync, openSync } from "node:fs";
import { HOUR } from "../core/clock";
import { log } from "../core/log";
import { AGENT_WORD, type SourceName } from "../core/names";
import { WINDOWS } from "../core/platform";
import { settings } from "../core/settings";
import type { SourceEvent } from "../records/source";
import {
  earliestAppleHealth,
  newestAppleHealth,
  readAppleHealth,
} from "../sources/apple-health";
import {
  archiveDb,
  incomingArchived,
  readEarliestArchived,
} from "../sources/archived";
import {
  exportCopiesOf,
  FORMATS,
  newestAssistant,
  readAssistant,
  readEarliestAssistant,
} from "../sources/assistants";
import { bridgedSource, NETWORKS } from "../sources/bridged";
import type { AppStore, Descriptor } from "../sources/contract";
import { newestCommit, readEarliestCommit, readGit } from "../sources/git";
import {
  DB,
  handleOf,
  incomingImessage,
  isImessageGroup,
  newestImessage,
  readEarliestImessage,
  readImessage,
} from "../sources/imessage";
import { lifelogMissing } from "../sources/lifelog";
import {
  incomingMail,
  mailRoot,
  newestMail,
  readEarliestMail,
  readMail,
} from "../sources/mail";
import { copyNotes, newestNote, readNotes } from "../sources/notes";
import {
  copyPhone,
  isPhoneGroup,
  newestPhone,
  readPhone,
} from "../sources/phone";
import { copyScreen, newestScreen, readScreen } from "../sources/screen";
import {
  copyWhatsapp,
  isWhatsappGroup,
  newestWhatsapp,
  phoneOf,
  readWhatsapp,
} from "../sources/whatsapp";
import { newestAgent, readAgent, readEarliestAgent } from "./agent-source";
import { readFiles } from "./ledger";
import { showFiles } from "./message-files";
import { newestTold, readEarliestTold, readTold } from "./told";

// The registry: every source's descriptor (`Descriptor`, `contract.ts`). The tables of sources are derived from it
// (`tablesOf`, below).

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
 * Every source, in the order units are cut (`gather` cuts lifelog's from the watcher's store first, then each other
 * source's in this order): of two with the same content, the first stays and the second is dropped as a duplicate.
 */
const LISTED: Descriptor[] = [
  // The Pendant: expected to hear him between 08:00 and 01:00 only (`waking`, snapshot.ts).
  {
    kind: "voice",
    label: "Pendant",
    missing: lifelogMissing,
    name: "lifelog",
    silentAfter: 6 * HOUR,
  },
  {
    chatDays: 7,
    earliest: readEarliestImessage,
    group: isImessageGroup,
    handleOf,
    incoming: incomingImessage,
    kind: "chat",
    label: "iMessage",
    macOnly: true,
    missing: () => unreadable(DB, FULL_DISK),
    name: "imessage",
    newest: newestImessage,
    read: (since, before) => readImessage(since, undefined, undefined, before),
    silentAfter: 24 * HOUR,
  },
  {
    chatDays: 7,
    group: isWhatsappGroup,
    handleOf: phoneOf,
    incoming: (from?: number) => incomingArchived("whatsapp", "id", from),
    kind: "chat",
    label: "WhatsApp",
    macOnly: true,
    name: "whatsapp",
    newest: newestWhatsapp,
    read: (since, before) => readWhatsapp(since, undefined, undefined, before),
    silentAfter: 24 * HOUR,
    store: {
      app: "WhatsApp",
      copies: "messages",
      copy: copyWhatsapp,
      deleted: { media: "media" },
    },
  },
  {
    chatDays: 7,
    group: isPhoneGroup,
    kind: "chat",
    label: "Phone & FaceTime",
    macOnly: true,
    name: "phone",
    newest: newestPhone,
    read: (since, before) => readPhone(since, undefined, undefined, before),
    silentAfter: 72 * HOUR,
    store: { copies: "calls", copy: copyPhone },
  },
  ...NETWORKS.map(bridgedSource),
  {
    earliest: readEarliestMail,
    incoming: incomingMail,
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
    read: (since, before) =>
      readMail(since, undefined, undefined, undefined, before),
    silentAfter: 12 * HOUR,
  },
  {
    kind: "own_writing",
    label: "Notes",
    macOnly: true,
    name: "notes",
    newest: newestNote,
    read: (since, before) => readNotes(since, undefined, before),
    silentAfter: 7 * 24 * HOUR,
    store: {
      app: "Notes",
      copies: "versions",
      copy: copyNotes,
      deleted: {},
    },
  },
  // His claude.ai and ChatGPT history, imported from their exports (memory/imports.ts): it gets new items only when he
  // imports a newer export, so its card is never amber; its newest is his newest imported message.
  ...(["claude", "chatgpt"] as const).map(
    (name): Descriptor => ({
      earliest: () => readEarliestAssistant(name),
      imported: true,
      kind: "own_writing",
      label: FORMATS[name].label,
      missing: () => (exportCopiesOf(name).length ? undefined : "not imported"),
      name,
      newest: () => newestAssistant(name),
      read: (since, before) => readAssistant(name)(since, undefined, before),
      silentAfter: Number.POSITIVE_INFINITY,
    })
  ),
  // What he told Life in a chat with ChatGPT or Claude (`tell_life`): his words marked, a question as the assistant's.
  {
    earliest: readEarliestTold,
    kind: "chat",
    label: "Told Life",
    name: "told",
    newest: newestTold,
    read: readTold,
    silentAfter: Number.POSITIVE_INFINITY,
  },
  // The agent's done tasks (decision 14, 21 Oct): Life's own ledger, never silent by its own fault.
  {
    earliest: readEarliestAgent,
    kind: "agent",
    label: "Agents",
    name: AGENT_WORD,
    newest: newestAgent,
    read: readAgent,
    silentAfter: Number.POSITIVE_INFINITY,
  },
  {
    earliest: readEarliestCommit,
    kind: "repo",
    label: "Git",
    missing: () => (settings().repos ? undefined : "no repos folder set"),
    name: "git",
    newest: newestCommit,
    read: (since, { me, repos }, before) =>
      readGit(since, repos, me, undefined, before),
    silentAfter: 72 * HOUR,
  },
  // His time in each app and website (Biome), on the Mac and the iOS devices that sync to it. The system writes it, so
  // no app is kept open; Biome prunes it after about a week, so the archive's copy is what is read.
  {
    kind: "screen",
    label: "Screen Time",
    macOnly: true,
    name: "screen",
    newest: newestScreen,
    read: (since, before) => readScreen(since, undefined, undefined, before),
    silentAfter: 24 * HOUR,
    store: { copies: "events", copy: () => copyScreen() },
  },
  {
    earliest: earliestAppleHealth,
    kind: "physical",
    label: "Apple Health",
    missing: lifelogMissing,
    name: "apple-health",
    newest: newestAppleHealth,
    read: readAppleHealth,
    silentAfter: 48 * HOUR,
  },
];

/** Whether its app is on this system: a Mac-only one only on the Mac. */
const appHere = (s: Descriptor) => !(s.macOnly && WINDOWS);

export const SOURCES = LISTED.map((s): Descriptor => {
  if (!(s.store || appHere(s))) {
    return { ...s, missing: () => "macOS only" };
  }
  // An archived source is there once the archive has copied its store.
  const { store } = s;
  return store
    ? {
        ...s,
        earliest: () => readEarliestArchived(s.name, store.copies),
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
 * its units and its days' episodes kept, shown as "can't read",
 * so it never fails a night (`gather` logs why); one that can be read and then throws still does (`safely`).
 */
export const readySources = (all = enabledSources()) =>
  all.filter((s) => !s.missing?.());

/** Whether a voice source is on and set up: what the watcher listens to, and what voice search and `read_day` read. */
export const listening = () => readySources().some((s) => s.kind === "voice");

const BY_NAME = new Map(SOURCES.map((s) => [s.name, s]));
/** A stored source name's descriptor: every name has one (`sources.test.ts`). */
export const sourceOf = (name: SourceName) => BY_NAME.get(name) as Descriptor;
export const kindOf = (name: SourceName) => sourceOf(name).kind;
/** Whether a chat is 1:1: not a group by its id (its source's `group`), or, for a source that cannot tell, one other sender at most. */
export const isDirect = (name: SourceName, chat: string, others: number) => {
  const { group } = sourceOf(name);
  return group ? !group(chat) : others <= 1;
};

/** A source whose events show their files as lines, as the ledger has them now. */
const withFiles =
  (read: (since: Date, before?: Date) => SourceEvent[]) =>
  (since: Date, before?: Date): SourceEvent[] =>
    showFiles(read(since, before), readFiles());

/**
 * The tables of sources the steps outside `gather` read, derived from a registry (`SOURCES`; another in a test): each
 * a source's name to its reader (its events showing their files), in cut order.
 */
export function tablesOf(sources: Descriptor[]) {
  const messages = sources.flatMap((s) =>
    s.kind === "repo" || s.kind === "voice" ? [] : [s]
  );
  const readers = (
    keep: (s: (typeof messages)[number]) => boolean,
    show = withFiles
  ) =>
    Object.fromEntries(
      messages.filter(keep).map((s) => [s.name, show(s.read)])
    );
  return {
    /** The chat apps, where people speak for themselves (not mail, nor his notes). */
    CHATS: readers((s) => s.kind === "chat"),
    /** His own writing (his notes, his imported assistant chats), as days of his persona: read by personas only. */
    OWN_WRITING: readers((s) => s.kind === "own_writing"),
    /** What `search` reads chat messages and notes from: the sources it has a window for. */
    SEARCHED: readers((s) => s.kind === "chat" || s.kind === "own_writing"),
    /** The mail `search` reads, in a section of its own. */
    SEARCHED_MAIL: readers((s) => s.kind === "mail"),
    /**
     * Where he writes with people, as the sources give it (no file lines): the chat apps and mail. Read over years once a
     * night (`readWithPeople`, closeness.ts), the one read of sources outside `gather`: closeness counts its 1:1 days and
     * personas sample their messages, 1:1 and in groups (their recordings come from the stored units).
     */
    WITH_PEOPLE: readers(
      (s) => s.kind === "chat" || s.kind === "mail",
      (read) => read
    ),
  };
}
/** The tables of the sources that can be read now, worked out on each call (settings and permissions change). */
export const tables = () => tablesOf(readySources());
export type Tables = ReturnType<typeof tablesOf>;

/**
 * Reads one source. A broken one is logged and named in `failed`, and gives no rows: the caller must not
 * mistake that for a quiet day (a unit file rebuilt without that source's units would lose them).
 */
export async function safely<T>(
  source: string,
  read: () => T[] | Promise<T[]>,
  failed: string[],
  isEveryReadLogged = true
): Promise<T[]> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    // ponytail: no timeout, every reader is synchronous (a timer could not fire); a hung source holds the run.
    const rows = await read();
    if (isEveryReadLogged) {
      log("source.read", { count: rows.length, ms: ms(), ok: true, source });
    }
    return rows;
  } catch (e) {
    log("source.read", {
      error: (e as Error).message,
      ms: ms(),
      ok: false,
      source,
    });
    failed.push(source);
    return [];
  }
}

/** `safely`, logging only a failure: a read repeated every few minutes (the watcher's sync of today). */
export const quietly: typeof safely = (source, read, failed) =>
  safely(source, read, failed, false);
