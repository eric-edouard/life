import { HOUR } from "../core/clock";
import { FULL_DISK, unreadable } from "../core/files";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
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
  readArchivedMessageAt,
  readEarliestArchived,
} from "../sources/archived";
import {
  FORMATS,
  hasExportCopy,
  newestAssistant,
  readAssistant,
  readEarliestAssistant,
} from "../sources/assistants";
import { bridgedSource } from "../sources/bridged";
import type { AppStore, Descriptor } from "../sources/contract";
import { newestCommit, readEarliestCommit, readGit } from "../sources/git";
import {
  copyGithub,
  githubSend,
  newestGithub,
  readGithub,
} from "../sources/github";
import { gmailSend } from "../sources/gmail";
import {
  DB,
  handleOf,
  imessageLinkOf,
  incomingImessage,
  isImessageGroup,
  newestImessage,
  readEarliestImessage,
  readImessage,
  readImessageAt,
  readSharedPictures,
} from "../sources/imessage";
import {
  incomingMail,
  mailRoot,
  newestMail,
  readEarliestMail,
  readMail,
  readMailAt,
} from "../sources/mail";
import { matrixSend } from "../sources/matrix";
import { messagesAppSend } from "../sources/messages-app";
import { NETWORKS, type Network } from "../sources/networks";
import { copyNotes, newestNote, readNotes } from "../sources/notes";
import {
  copyPhone,
  isPhoneGroup,
  newestPhone,
  readPhone,
} from "../sources/phone";
import {
  earliestPhoto,
  newestPhoto,
  PHOTOS_DB,
  readPhotos,
} from "../sources/photos";
import { copyScreen, newestScreen, readScreen } from "../sources/screen";
import { voiceServerMissing } from "../sources/voice-server-call";
import {
  copyWhatsapp,
  isWhatsappGroup,
  newestWhatsapp,
  phoneOf,
  readWhatsapp,
  readWhatsappPictures,
  whatsappEventOf,
  whatsappGhostOf,
  whatsappHandleOf,
  whatsappIdOf,
  whatsappLinkOf,
  whatsappRoomOf,
} from "../sources/whatsapp";
import { newestAgent, readAgent, readEarliestAgent } from "./agent-source";
import { deletedEventsOf } from "./deletions";
import { deletionsNow } from "./memory-files";
import { readFiles, showFiles } from "./message-files";
import {
  newestToldLife,
  readEarliestToldLife,
  readToldLife,
} from "./told-life";

// The registry: every source's descriptor (`Descriptor`, `contract.ts`). The tables of sources are derived from it
// (`tablesOf`, below).

/**
 * Every source, in the order units are cut (`gather` cuts the voice units from the watcher's store first, then each other
 * source's in this order): of two with the same content, the first stays and the second is dropped as a duplicate.
 */
const LISTED: Descriptor[] = [
  // The Pendant: expected to hear him between 08:00 and 01:00 only (`waking`, integration-health.ts).
  {
    capturesOnItsOwn: true,
    integration: {
      privacy:
        "What the pendant hears goes to this computer through your phone; speech is turned into text here (a language outside the local set goes to ElevenLabs), then the text to the AI you chose.",
      requirements: [
        { kind: "device", what: "phone" },
        { kind: "device", what: "pendant" },
      ],
      value: {
        answer: "Sam said he'd send the quote by Friday.",
        ask: "What did Sam and I agree on yesterday?",
      },
    },
    kind: "voice",
    label: "Pendant",
    missing: voiceServerMissing,
    name: "voice",
    silentAfter: 6 * HOUR,
  },
  {
    capturesOnItsOwn: true,
    chatDays: 7,
    chatLinkOf: imessageLinkOf,
    earliest: readEarliestImessage,
    group: isImessageGroup,
    handleOf,
    hasPhoneHandles: true,
    incoming: incomingImessage,
    integration: {
      privacy:
        "Read on this computer from the Messages app's store; what Life reads goes to the AI you chose, and turning the source off stops it.",
      requirements: [{ check: "full_disk_access", kind: "permission" }],
      value: {
        answer: "Sam's message from Tuesday: dinner at 8, his place.",
        ask: "What did Sam say about Saturday?",
      },
    },
    kind: "chat",
    label: "iMessage",
    macOnly: true,
    messageAt: (id) => readImessageAt(id),
    missing: () => unreadable(DB, FULL_DISK),
    name: "imessage",
    newest: newestImessage,
    pictures: () => readSharedPictures(),
    read: (since, before) => readImessage(since, undefined, undefined, before),
    send: messagesAppSend(),
    silentAfter: 24 * HOUR,
  },
  {
    capturesOnItsOwn: true,
    chatDays: 7,
    chatLinkOf: whatsappLinkOf,
    group: isWhatsappGroup,
    // A 1:1 chat's handle: its phone, else its `@lid` (read as its phone where the bridge knows it).
    handleOf: (key: string) => phoneOf(key) ?? whatsappHandleOf(key),
    incoming: (from?: number) => incomingArchived("whatsapp", "id", from),
    kind: "chat",
    label: "WhatsApp",
    macOnly: true,
    messageAt: (id) => readArchivedMessageAt("whatsapp", id),
    name: "whatsapp",
    newest: newestWhatsapp,
    pictures: () => readWhatsappPictures(),
    read: (since, before) => readWhatsapp(since, undefined, undefined, before),
    send: {
      ...matrixSend("whatsapp", {
        eventOf: whatsappEventOf,
        ghostOf: whatsappGhostOf,
        handleOf: whatsappHandleOf,
        idOf: whatsappIdOf,
        roomsOf: () => whatsappRoomOf,
      }),
      opensHint:
        "a new person's id as <digits>@s.whatsapp.net (a group it never saw can't be opened)",
    },
    silentAfter: 24 * HOUR,
    store: {
      app: "WhatsApp",
      copies: "messages",
      copy: copyWhatsapp,
      deleted: { media: "media" },
    },
  },
  {
    capturesOnItsOwn: true,
    chatDays: 7,
    group: isPhoneGroup,
    hasPhoneHandles: true,
    integration: {
      privacy:
        "Read on this computer from the Phone app's store; what Life reads goes to the AI you chose, and turning the source off stops it.",
      requirements: [{ check: "full_disk_access", kind: "permission" }],
      value: {
        answer: "Ana called you on Sunday at 9pm, for 12 minutes.",
        ask: "When did I last talk to Ana?",
      },
    },
    kind: "chat",
    label: "Phone & FaceTime",
    macOnly: true,
    name: "phone",
    newest: newestPhone,
    read: (since, before) => readPhone(since, undefined, undefined, before),
    silentAfter: 72 * HOUR,
    store: { copies: "calls", copy: copyPhone },
  },
  ...NETWORKS.filter((n: Network) => !n.readByItsApp).map(bridgedSource),
  {
    capturesOnItsOwn: true,
    chatDays: 30,
    // Every issue is a thread of many: never a 1:1 chat.
    group: () => true,
    incoming: (from?: number) => incomingArchived("github", "eventId", from),
    integration: {
      privacy:
        "Read through your own gh sign-in from the repos you list; what Life reads goes to the AI you chose, and turning the source off stops it.",
      requirements: [],
      value: {
        answer: "Three pull requests on two repos, the last one on Friday.",
        ask: "What did I merge this week?",
      },
    },
    isWorkTracker: true,
    kind: "chat",
    label: "GitHub",
    messageAt: (id) => readArchivedMessageAt("github", id),
    missing: () =>
      settings().githubRepos ? undefined : "no repos listed (`githubRepos`)",
    name: "github",
    newest: newestGithub,
    read: (since, before) => readGithub(since, undefined, before),
    send: githubSend(),
    silentAfter: Number.POSITIVE_INFINITY,
    store: { copies: "messages", copy: copyGithub },
  },
  {
    capturesOnItsOwn: true,
    chatLinkOf: (handle) =>
      handle.includes("@") ? `mailto:${handle}` : undefined,
    earliest: readEarliestMail,
    incoming: incomingMail,
    integration: {
      privacy:
        "Read on this computer from Mail's own store; what Life reads goes to the AI you chose, and turning the source off stops it.",
      requirements: [{ check: "full_disk_access", kind: "permission" }],
      value: {
        answer:
          "Ana asked on Monday whether it went out; you said it would that week.",
        ask: "What did Ana ask me about the invoice?",
      },
    },
    kind: "mail",
    label: "Mail",
    macOnly: true,
    messageAt: (id) => readMailAt(id),
    missing: () => {
      try {
        mailRoot();
      } catch {
        return FULL_DISK;
      }
    },
    name: "mail",
    newest: newestMail,
    read: (since, before) => readMail(since, undefined, undefined, before),
    send: gmailSend(),
    silentAfter: 12 * HOUR,
  },
  {
    integration: {
      privacy:
        "Read on this computer from the Notes app's store; what Life reads goes to the AI you chose, and turning the source off stops it.",
      requirements: [{ check: "full_disk_access", kind: "permission" }],
      value: {
        answer:
          "Your note from 4 October: the order for Sam's birthday, to collect at 10.",
        ask: "What did I write down about the bakery?",
      },
    },
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
  ...(["claude", "chatgpt"] as const).map((name): Descriptor => {
    const { label } = FORMATS[name];
    return {
      earliest: () => readEarliestAssistant(name),
      imported: true,
      integration: {
        privacy: `Read from the ${label} export file you drop in; nothing new is fetched. What Life reads goes to the AI you chose.`,
        requirements: [],
        value: {
          answer:
            "You asked whether to raise the base price; it suggested testing it on new customers.",
          ask: `What did I ask ${label} about pricing?`,
        },
      },
      kind: "own_writing",
      label,
      missing: () => (hasExportCopy(name) ? undefined : "not imported"),
      name,
      newest: () => newestAssistant(name),
      read: (since, before) => readAssistant(name)(since, undefined, before),
      silentAfter: Number.POSITIVE_INFINITY,
    };
  }),
  // What he told Life in a chat with ChatGPT or Claude (`tell_life`): his words marked, a question as the assistant's.
  {
    earliest: readEarliestToldLife,
    kind: "chat",
    label: "Told Life",
    name: "told-life",
    newest: newestToldLife,
    read: readToldLife,
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
    integration: {
      privacy:
        "Read on this computer from the repos in your folder; what Life reads of their commits goes to the AI you chose, and turning the source off stops it.",
      requirements: [],
      value: {
        answer:
          "Fourteen commits across three repos, most of them on Wednesday.",
        ask: "How much did I commit this week?",
      },
    },
    kind: "repo",
    label: "Git",
    missing: () => (settings().reposFolder ? undefined : "no repos folder set"),
    name: "git",
    newest: newestCommit,
    read: (since, { me, repos }, before) =>
      readGit(since, repos, me, undefined, before),
    silentAfter: 72 * HOUR,
  },
  // His time in each app and website (Biome), on the Mac and the iOS devices that sync to it. The system writes it, so
  // no app is kept open; Biome prunes it after about a week, so the archive's copy is what is read.
  {
    integration: {
      privacy:
        "Read on this computer from Screen Time's store; what Life reads goes to the AI you chose, and turning the source off stops it.",
      requirements: [{ check: "full_disk_access", kind: "permission" }],
      value: {
        answer:
          "Four hours in your editor and one in the browser, most of it in the morning.",
        ask: "What did I spend most time on yesterday?",
      },
    },
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
    integration: {
      privacy:
        "Sent by your phone's app to this computer; what Life reads goes to the AI you chose, and turning the source off stops it.",
      requirements: [],
      value: {
        answer:
          "Six hours a night on average, with the best night on Thursday.",
        ask: "How did I sleep this week?",
      },
    },
    kind: "physical",
    label: "Apple Health",
    missing: voiceServerMissing,
    name: "apple-health",
    newest: newestAppleHealth,
    read: readAppleHealth,
    silentAfter: 48 * HOUR,
  },
  // His photo library, read in place from Photos' own store: Photos keeps its history, so nothing is copied.
  {
    earliest: earliestPhoto,
    hasPhoneHandles: true,
    integration: {
      privacy:
        "The photos themselves never leave this computer: a local model describes them on the Mac, and only those descriptions go to the AI you chose.",
      requirements: [{ check: "full_disk_access", kind: "permission" }],
      value: {
        answer:
          "Nine photos from the coast: the beach, two dinners and the market.",
        ask: "What did I photograph last weekend?",
      },
    },
    kind: "photos",
    label: "Photos",
    macOnly: true,
    missing: () => unreadable(PHOTOS_DB, FULL_DISK),
    name: "photos",
    newest: newestPhoto,
    read: readPhotos,
    silentAfter: 7 * 24 * HOUR,
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

/** Whether the `told-life` source is on: else nothing would read what `tell_life` keeps. */
export const isToldLife = () => settings().sources.includes("told-life");

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
/** Where he writes with people: a chat or mail. Only such a unit's reading is continued (`continuedFrom`). */
export const isWithPeople = (kind: Descriptor["kind"]) =>
  kind === "chat" || kind === "mail";
/** Whether a chat is 1:1: not a group by its id (its source's `group`), or, for a source that cannot tell, one other sender at most. */
export const isDirect = (name: SourceName, chat: string, others: number) => {
  const { group } = sourceOf(name);
  return group ? !group(chat) : others <= 1;
};
/** The link that opens a chat in its network's app: the first of `handles` (the chat's own, then a sender's) its network opens (`chatLinkOf`; a WhatsApp `@lid` opens nothing); none when none does. */
export const chatOpenUrlOf = (
  name: SourceName,
  handles: readonly (string | undefined)[]
) =>
  handles
    .map((h) => h && sourceOf(name).chatLinkOf?.(h))
    .find((url): url is string => Boolean(url));

/** A source whose events show their files as lines, as the ledger has them now. */
const withFiles =
  (read: (since: Date, before?: Date) => SourceEvent[]) =>
  (since: Date, before?: Date): SourceEvent[] =>
    showFiles(read(since, before), readFiles());

/**
 * A source's reader with what he deleted applied (`deletedEventsOf`): the one way a source's words come in, the send paths
 * aside (`draft-send.ts`, which must send exactly what he approved).
 */
export const deletedReadOf =
  (name: string, read: (since: Date, before?: Date) => SourceEvent[]) =>
  (since: Date, before?: Date): SourceEvent[] =>
    deletedEventsOf(name, read(since, before), deletionsNow());

/** Whether search reads a source's text as passages (`passages.ts`): chats, mail, his own writing and his photos, one passage each. */
export const isSearched = (s: Pick<Descriptor, "kind">) =>
  s.kind === "chat" ||
  s.kind === "mail" ||
  s.kind === "own_writing" ||
  s.kind === "photos";

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
      messages
        .filter(keep)
        .map((s) => [s.name, show(deletedReadOf(s.name, s.read))])
    );
  return {
    /** The chat apps, where people speak for themselves (not mail, nor his notes). */
    CHATS: readers((s) => s.kind === "chat"),
    /** His own writing (his notes, his imported assistant chats), as days of his persona: read by personas only. */
    OWN_WRITING: readers((s) => s.kind === "own_writing"),
    /** What `search` reads chat messages and notes from: the sources it has a window for. */
    SEARCHED: readers((s) => isSearched(s) && s.kind !== "mail"),
    /** The mail `search` reads, in a section of its own. */
    SEARCHED_MAIL: readers((s) => s.kind === "mail"),
    /**
     * Where he writes with people, as the sources give it (no file lines): the chat apps and mail. Read over years once a
     * night (`readWithPeople`, closeness.ts), the one read of sources outside `gather`: closeness counts its 1:1 days and
     * personas sample their messages, 1:1 and in groups (their recordings come from the stored units).
     */
    WITH_PEOPLE: readers(
      (s) => isWithPeople(s.kind),
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
      ...errorOf(e),
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
