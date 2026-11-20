import type { SourceName } from "../core/names";
import type { DirectoryParty } from "../records/truth";
import { type Contact, contactKeyOf, PHONE_WRITTEN } from "../sources/contacts";
import { readPersonUnitFiles } from "./person-units";
import { sourceOf } from "./sources";

// How to reach someone (docs/glossary.md, "reach"): per app, the accounts Life knows for them, each with the link that
// opens it on his phone. Worked out when read, from his directory, his Contacts and their chats; never stored.

/** One account on an app: what it shows as (`title`), its handle, the link that opens it and their last chat there. */
export interface ReachAccount {
  handle: string;
  lastAt?: string;
  open: { lands: "call" | "chat"; url: string };
  /** The name they show on that app where Life saw the account in a chat, else his Contacts' label ("Mobile"); absent: the handle is its title. */
  title?: string;
}

/** An app and their accounts on it, newest exchange first. */
export interface Reach {
  accounts: ReachAccount[];
  label: string;
  network: SourceName | "call";
}

/** A 1:1 chat Life holds with them: where, by which handle, the name it showed, and when it last held a message. */
export interface SeenAccount {
  handle: string;
  lastAt: string;
  shownName?: string;
  source: SourceName;
}

/** How many accounts an app shows, the newest exchange first: the others his directory or Contacts hold stay in `now`'s `details`. */
const REACH_ACCOUNTS = 3;

/** How many of their newest chat-days are read for the accounts they write from. */
const SEEN_UNITS = 60;

/** A phone's call link, `tel:+<digits>`; none for anything that is no phone. */
const callLinkOf = (handle: string) =>
  PHONE_WRITTEN.test(handle) && handle.replace(/\D/g, "").length >= 7
    ? `tel:${handle.startsWith("+") ? "+" : ""}${handle.replace(/\D/g, "")}`
    : undefined;

/** The apps a person is reached on, in the People page's order: each source opens its chats, then a call. */
const APPS: {
  handles: (d: Handles) => string[];
  network: SourceName | "call";
}[] = [
  { handles: (d) => d.whatsapp, network: "whatsapp" },
  { handles: (d) => [...d.phone, ...d.cardPhones], network: "imessage" },
  { handles: (d) => (d.telegram ? [d.telegram] : []), network: "telegram" },
  { handles: (d) => [...d.email, ...d.cardMails], network: "mail" },
  {
    handles: (d) => [...d.phone, ...d.whatsapp, ...d.cardPhones],
    network: "call",
  },
];

interface Handles {
  cardMails: string[];
  cardPhones: string[];
  email: string[];
  phone: string[];
  telegram?: string;
  whatsapp: string[];
}

/** A handle once however it is written: a phone or an email by its contact key. */
const keyOf = (h: string) => contactKeyOf(h) ?? h;

/**
 * Their reach: per app (`APPS`), every account his directory, his Contacts or their own 1:1 chats give, once each, that
 * opens (the source's `chatLinkOf`, a call's `tel:`); its title the name they showed there, else Contacts' label; newest
 * exchange first. An app with no account that opens is left out. Pure.
 */
export function reachOf({
  cards,
  party,
  seen,
}: {
  cards: readonly Contact[];
  party?: Pick<DirectoryParty, "handles">;
  seen: readonly SeenAccount[];
}): Reach[] {
  const handles = cards.flatMap((c) => c.handles);
  const directory: Handles = {
    cardMails: handles.filter((h) => h.includes("@")),
    cardPhones: handles.filter((h) => !h.includes("@")),
    email: party?.handles.email ?? [],
    phone: party?.handles.phone ?? [],
    telegram: party?.handles.telegram,
    whatsapp: party?.handles.whatsapp ?? [],
  };
  const labels = new Map(
    cards.flatMap((c) =>
      Object.entries(c.labels).map(([h, label]) => [keyOf(h), label] as const)
    )
  );
  return APPS.flatMap(({ handles: of, network }): Reach[] => {
    const theirs = seen.filter((s) => s.source === network);
    const found = new Map<string, ReachAccount>();
    for (const handle of [...theirs.map((s) => s.handle), ...of(directory)]) {
      const key = keyOf(handle);
      const account = found.has(key)
        ? undefined
        : accountOf(network, handle, theirs, labels.get(key));
      if (account) {
        found.set(key, account);
      }
    }
    const accounts = [...found.values()]
      .toSorted((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""))
      .slice(0, REACH_ACCOUNTS);
    return accounts.length > 0
      ? [
          {
            accounts,
            label: network === "call" ? "Call" : sourceOf(network).label,
            network,
          },
        ]
      : [];
  });
}

/** One account on `network`, with its newest chat among `theirs` and its Contacts label; none when nothing opens it. */
function accountOf(
  network: Reach["network"],
  handle: string,
  theirs: readonly SeenAccount[],
  label: string | undefined
): ReachAccount | undefined {
  const url =
    network === "call"
      ? callLinkOf(handle)
      : sourceOf(network).chatLinkOf?.(handle);
  if (!url) {
    return;
  }
  const [chat] = theirs
    .filter((s) => keyOf(s.handle) === keyOf(handle))
    .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt));
  const title = chat?.shownName ?? label;
  return {
    handle,
    ...(chat ? { lastAt: chat.lastAt } : {}),
    open: { lands: network === "call" ? "call" : "chat", url },
    ...(title ? { title } : {}),
  };
}

/**
 * The accounts `ref` wrote from in their newest 1:1 chat-days (`SEEN_UNITS`): one query of the index, then those
 * units' files (never a source). A chat-day whose source holds no handle in its key is left out.
 */
export function readSeenAccounts(ref: string): SeenAccount[] {
  return readPersonUnitFiles([ref], {
    count: SEEN_UNITS,
    kinds: ["chat"],
  }).units.flatMap(({ direct, unit: u }) => {
    const handle = direct && sourceOf(u.source).handleOf?.(u.key);
    return handle
      ? [
          {
            handle,
            lastAt: u.end,
            ...(u.title === u.key ? {} : { shownName: u.title }),
            source: u.source,
          },
        ]
      : [];
  });
}
