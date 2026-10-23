import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HOUR } from "../core/clock";
import { MACHINE_DIR } from "../core/platform";
import { execOk } from "../core/proc";
import { settings } from "../core/settings";
import type { SourceEvent } from "../records/source";
import type { Newest } from "./contract";
import {
  decodeWords,
  isSentBox,
  isSkippedBox,
  mailEvents,
  mailIdOf,
  readMessage,
  SKIPPED_BOXES,
  type StoredMessage,
} from "./mail";

// His mail on a host without Mail.app: mbsync mirrors his IMAP mailbox into a Maildir (`mirrorImap`, the `imap`
// setting), and the mail source reads that copy as it reads Mail's store on the Mac (`readMaildir`). Pull only: Life
// never writes his mailbox, and the copy follows it (a message gone there goes here).

const DIR = join(MACHINE_DIR, "mail");
export const MAILDIR = join(DIR, "maildir");
// ponytail: a message over 25 MB is left out of the copy whole; raise it if big attachments matter.
const MAX_SIZE = "25m";
const ADDRESS = /<([^>]+)>/;
const PREFIX = /^(?:(?:re|fwd?|tr|aw)\s*:\s*)+/i;
const FLAGS = /:2,([A-Z]*)$/;
const DRAFT_OR_TRASHED = /[DT]/;
const SEP = /[/\\]/;

type Imap = NonNullable<ReturnType<typeof settings>["imap"]>;

/** mbsync's configuration for `imap`, mirroring into `dir`: the password from the environment, never written down. */
export const mbsyncConfig = (imap: Imap, dir: string) =>
  `IMAPAccount life
Host ${imap.host}
Port ${imap.port}
User ${imap.user}
PassCmd "printenv LIFE_IMAP_PASSWORD"
TLSType ${imap.port === 993 ? "IMAPS" : "STARTTLS"}

IMAPStore far
Account life

MaildirStore near
Path ${dir}/
Inbox ${dir}/INBOX
SubFolders Verbatim

Channel life
Far :far:
Near :near:
Patterns ${(imap.folders ?? ["*", ...SKIPPED_BOXES.flatMap((w) => [`!*${w}*`, `!*${w[0]?.toUpperCase()}${w.slice(1)}*`])]).map((p) => JSON.stringify(p)).join(" ")}
Create Near
Sync Pull
Expunge Near
SyncState *
MaxSize ${MAX_SIZE}
`;

/** Brings the copy up to date with his mailbox (the first run copies it all: hours for years of mail). */
export async function mirrorImap(imap = settings().imap) {
  if (!imap) {
    return;
  }
  mkdirSync(MAILDIR, { recursive: true });
  const config = join(DIR, "mbsyncrc");
  writeFileSync(config, mbsyncConfig(imap, MAILDIR));
  await execOk(["mbsync", "--config", config, "--all", "--quiet"], {
    timeout: 12 * HOUR,
  });
}

/** Every mail folder under `root`, by its name (a folder holds `cur` and `new`). */
function folders(root: string): { dir: string; name: string }[] {
  const here = existsSync(join(root, "cur"))
    ? [{ dir: root, name: root.split(SEP).at(-1) ?? "" }]
    : [];
  return [
    ...here,
    ...readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !["cur", "new", "tmp"].includes(e.name))
      .flatMap((e) => folders(join(root, e.name))),
  ];
}

/** Whether mbsync has copied any folder yet. */
export const isMirrored = (root = MAILDIR) =>
  existsSync(root) && folders(root).length > 0;

/** Each message file in the copy, with its folder and when the server received it (mbsync sets it as the file's time). */
function files(root: string) {
  return folders(root).flatMap(({ dir, name }) =>
    ["cur", "new"].flatMap((sub) =>
      readdirSync(join(dir, sub)).flatMap((f) => {
        // mbsync renames a file whose flags change, and removes one gone from the mailbox, while Life reads.
        const at = statSync(join(dir, sub, f), {
          throwIfNoEntry: false,
        })?.mtimeMs;
        return at === undefined
          ? []
          : [
              {
                at,
                box: name,
                flags: f.match(FLAGS)?.[1] ?? "",
                path: join(dir, sub, f),
              },
            ];
      })
    )
  );
}

const addressOf = (from = "") =>
  (from.match(ADDRESS)?.[1] ?? from).trim().toLowerCase() || "unknown";
const bare = (id = "") => id.match(ADDRESS)?.[1] ?? "";
/** A message's id in the copy: its Message-ID, else its file's unique name (the same whatever its flags). */
const idOfFile = (path: string) => (h: Map<string, string>) =>
  mailIdOf(h.get("message-id"), path.split(SEP).at(-1)?.split(":")[0] ?? path);
/** The message in a file of the copy; nothing when mbsync moved it meanwhile (the next read finds it under its new name). */
const messageAt = (path: string) => {
  try {
    return readMessage(path, idOfFile(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw e;
  }
};

/** Whether the file at `path` is a whole message (an .emlx, a file of the copy), its files inside it. */
export const isMessageFile = (path: string, root = MAILDIR) =>
  path.endsWith(".emlx") || path.startsWith(join(root, "/"));

/** The copy's messages received at or after `since`, oldest first, as Mail's store gives them. */
function messagesSince(since: Date, root: string): StoredMessage[] {
  return files(root)
    .filter((f) => f.at >= since.getTime())
    .sort((a, b) => a.at - b.at)
    .flatMap((f) => {
      const read = messageAt(f.path);
      if (!read) {
        return [];
      }
      const { headers } = read;
      const subject = decodeWords(headers.get("subject") ?? "");
      // The thread's first message, which every reply's References start with.
      const thread =
        bare(headers.get("references")) || bare(headers.get("in-reply-to"));
      const id = idOfFile(f.path)(headers);
      return [
        {
          at: new Date(f.at).toISOString(),
          bulk: headers.has("list-id") || headers.has("list-unsubscribe"),
          chat: thread ? `mail:${thread}` : id,
          chatName: subject.replace(PREFIX, ""),
          id,
          isSent: isSentBox(f.box),
          // A draft or a deleted message, by its flag: Gmail keeps both in All Mail too.
          isSkipped: isSkippedBox(f.box) || DRAFT_OR_TRASHED.test(f.flags),
          path: f.path,
          prefix: subject.match(PREFIX)?.[0] ?? "",
          sender: addressOf(headers.get("from")),
        },
      ];
    });
}

/** His mail in the copy at `root` since `since`: his own by his login and his sent folders. */
export function readMaildir(
  since: Date,
  root = MAILDIR,
  user = settings().imap?.user ?? ""
): SourceEvent[] {
  return mailEvents(messagesSince(since, root), [user]);
}

/** The newest message in the copy, its sender and subject (the status snapshot). */
export function newestMaildir(root = MAILDIR): Newest {
  const [newest] = files(root).sort((a, b) => b.at - a.at);
  if (!newest) {
    return { at: null };
  }
  const headers = messageAt(newest.path)?.headers ?? new Map<string, string>();
  return {
    at: new Date(newest.at).toISOString(),
    words: [
      `${headers.get("from") ?? "?"}: ${decodeWords(headers.get("subject") ?? "")}`,
    ],
  };
}
