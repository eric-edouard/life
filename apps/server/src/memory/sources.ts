import { closeSync, existsSync, openSync } from "node:fs";
import { HOUR, MIN } from "../core/clock";
import { log } from "../core/log";
import { AGENT_WORD, type SourceName } from "../core/names";
import { MAC } from "../core/platform";
import { agentName, settings } from "../core/settings";
import { archiveDb } from "../sources/archived";
import {
  FORMATS,
  importOf,
  newestAssistant,
  readAssistant,
} from "../sources/assistants";
import {
  copyBeeper,
  newestBeeper,
  openBeeper,
  readBeeper,
} from "../sources/beeper";
import type { AppStore, Descriptor } from "../sources/contract";
import { mirrorForge } from "../sources/forge";
import { newestCommit, REPOS_DIR, readGit } from "../sources/git";
import {
  isMirrored,
  mirrorImap,
  newestMaildir,
  readMaildir,
} from "../sources/imap";
import {
  DB,
  handleOf,
  isImessageGroup,
  newestImessage,
  readImessage,
} from "../sources/imessage";
import { lifelogMissing } from "../sources/lifelog";
import { mailRoot, newestMail, readMail } from "../sources/mail";
import { copyNotes, newestNote, openNotes, readNotes } from "../sources/notes";
import {
  copyWhatsapp,
  isWhatsappGroup,
  newestWhatsapp,
  openWhatsapp,
  phoneOf,
  readWhatsapp,
} from "../sources/whatsapp";
import { newestAgent, readAgent } from "./agent-source";
import { loadTruth } from "./read-truth";

// The registry: every source's descriptor (`Descriptor`, `contract.ts`). The tables of sources are derived from it
// (`tablesOf`, units.ts).

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
      open: openWhatsapp,
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
      open: openBeeper,
    },
  },
  // His mail, read from a copy on this host: the Maildir mbsync keeps of his IMAP mailbox when the `imap` setting is
  // set (a server), else Mail.app's own store (the Mac).
  {
    kind: "mail",
    label: "Mail",
    name: "mail",
    searchDays: 90,
    silentAfter: 12 * HOUR,
    ...(settings().imap
      ? {
          mirror: () => mirrorImap(),
          missing: () => {
            if (!process.env.LIFE_IMAP_PASSWORD) {
              return "no LIFE_IMAP_PASSWORD";
            }
            return isMirrored() ? undefined : "not mirrored yet";
          },
          newest: () => newestMaildir(),
          read: (since: Date) => readMaildir(since),
        }
      : {
          macOnly: true as const,
          missing: () => {
            try {
              mailRoot();
            } catch {
              return FULL_DISK;
            }
          },
          newest: newestMail,
          read: (since: Date) => readMail(since),
        }),
  },
  {
    kind: "own_writing",
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
      open: openNotes,
    },
  },
  // His claude.ai and ChatGPT history, imported once (memory/imports.ts): it never gets new items, so its card is never
  // amber; its newest is his newest imported message. ponytail: search reads every pruned message (the export parsed once per process,
  // every sweep included); index them in index.sqlite if that grows slow.
  ...(["claude", "chatgpt"] as const).map(
    (name): Descriptor => ({
      imported: true,
      kind: "own_writing",
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
    missing: () => {
      if (!settings().repos) {
        return "no repos folder set";
      }
      return settings().forge && !process.env.GITHUB_TOKEN
        ? "no GITHUB_TOKEN"
        : undefined;
    },
    // On a host without his checkouts, the repos his projects list, from his forge.
    ...(settings().forge
      ? {
          mirror: async () => {
            if (REPOS_DIR) {
              await mirrorForge(
                (await loadTruth()).projects.flatMap((p) => p.repos),
                REPOS_DIR
              );
            }
          },
        }
      : {}),
    name: "git",
    newest: newestCommit,
    read: (since, { me, repos }) => readGit(since, repos, me),
    silentAfter: 72 * HOUR,
  },
];

/** Whether its app is on this system: a Mac-only one only on the Mac. */
const appHere = (s: Descriptor) => !(s.macOnly && !MAC);

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

export const MIRROR_EVERY_MS = 5 * MIN;
let mirroring = false;
/**
 * Brings the network sources he turned on to this host (`mirror`), one after another, never two passes at once (a
 * mailbox's first copy takes hours): a failure is logged, and the others still run.
 */
export async function mirrorSources() {
  if (mirroring) {
    return;
  }
  mirroring = true;
  try {
    for (const s of enabledSources()) {
      // biome-ignore lint/performance/noAwaitInLoops: one copy at a time
      await s.mirror?.().catch((e: Error) =>
        log("run.error", {
          error: e.message,
          source: s.name,
          step: "source.mirror",
        })
      );
    }
  } finally {
    mirroring = false;
  }
}

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
