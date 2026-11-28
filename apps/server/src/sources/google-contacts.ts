import { MIN } from "../core/clock";
import { type GoogleAccount, gogCall } from "../core/gog";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { exec } from "../core/proc";
import type { Contact } from "./contacts";

// His Google Contacts, read through gog for the accounts whose grant carries Google Contacts: the names and handles
// Life joins to the ones his Mac's Contacts give (`writeContactPeople`), so a sender only Google knows is named too.
// Only people he saved are listed (not Google's "other contacts"); a person's primary email and phone are what a
// listing gives. Read only while the `gmail` source is on, which is its off switch; nothing is stored here.

/** The read-only scope Google Contacts is read under: `connectGoogle` asks for it, and only a grant carrying it is read. */
export const CONTACTS_SCOPE =
  "https://www.googleapis.com/auth/contacts.readonly";

/** People per page: gog's own maximum, so a book of a few thousand people is a handful of pages. */
const PAGE = 1000;
/** A page is given gog's minute, and a big one a little more. */
const PAGE_MS = 2 * MIN;

interface Run {
  code: number;
  stderr: string;
  stdout: string;
}

/** A person as `gog contacts list` gives it: its card's resource name, its primary name, email and phone. */
interface GooglePerson {
  email?: string;
  name?: string;
  phone?: string;
  resource?: string;
}

interface Page {
  contacts?: GooglePerson[];
  nextPageToken?: string;
}

/**
 * One person as a Contacts card: its names and handles alone, since a birthday and the rest are his Mac's Contacts'
 * (`memory/details.ts`). An email is lower-cased as Contacts keeps it, a phone as Google writes it; a person with
 * neither, or without a card, is no card.
 */
function cardOf(p: GooglePerson): Contact[] {
  const handles = [p.email?.trim().toLowerCase(), p.phone?.trim()].flatMap(
    (h) => (h ? [h] : [])
  );
  const name = p.name?.trim();
  return p.resource && handles.length > 0
    ? [
        {
          addresses: [],
          birthday: null,
          company: null,
          handles,
          id: `google:${p.resource}`,
          labels: {},
          name: name || null,
          profiles: [],
          related: [],
          work: null,
        },
      ]
    : [];
}

/** Every card `account`'s listing holds, each page after the one before; a failed page throws. */
async function cardsOf(address: string, run: NonNullable<Options["run"]>) {
  const cards: Contact[] = [];
  const asked = new Set<string>();
  let page = "";
  while (!asked.has(page)) {
    asked.add(page);
    const [cmd, { env }] = gogCall("contacts", address, [
      "list",
      `--max=${PAGE}`,
      ...(page ? [`--page=${page}`] : []),
      "--readonly",
    ]);
    // biome-ignore lint/performance/noAwaitInLoops: each page is asked after the one it follows
    const r = await run(cmd, { env, timeout: PAGE_MS });
    if (r.code !== 0) {
      throw new Error((r.stderr || r.stdout).trim().slice(-300));
    }
    const answer = JSON.parse(r.stdout.trim() || "{}") as Page;
    cards.push(...(answer.contacts ?? []).flatMap(cardOf));
    page = answer.nextPageToken ?? "";
  }
  return cards;
}

interface Options {
  /** Runs gog (`gogCall`'s command line and environment); a test passes its own. */
  run?: (
    cmd: string[],
    o: { env: Record<string, string | undefined>; timeout: number }
  ) => Promise<Run>;
}

/**
 * The cards of every account whose grant carries Google Contacts: the accounts he signed in with `connectGoogle`, less
 * one whose token no longer works. An account that can't be read is logged and gives no card, so the night's people
 * still read as his Mac's Contacts give them.
 */
export async function readGoogleContacts(
  accounts: GoogleAccount[],
  { run = (cmd, o) => exec(cmd, o) }: Options = {}
): Promise<Contact[]> {
  const cards: Contact[] = [];
  for (const account of accounts.filter(
    (a) => a.valid && a.scopes.includes(CONTACTS_SCOPE)
  )) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each account is read on its own
      cards.push(...(await cardsOf(account.address, run)));
    } catch (e) {
      log("source.read", {
        ...errorOf(e),
        ok: false,
        source: "google contacts",
      });
    }
  }
  return cards;
}
