import type { Database } from "bun:sqlite";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { clock } from "../core/clock";
import { openReadOnly } from "../core/sqlite";
import { ARCHIVE, archiveDb } from "./archived";
import { AS_READ, insertVersions, openBridged, portalsOf } from "./bridged";
import { BRIDGES } from "./matrix";

// Instagram's own export of his account (Meta's "Download your information", JSON), brought into the Instagram
// archive as export rows (docs/sources.md): each chat's messages land in the chat the bridge or Beeper already
// copied it under, the ones the archive holds are skipped, and the files they name are cloned into the archive's
// media. What the export is worth is decided here once and frozen in the rows: the one reader stays `readBridged`.
// The export is untrusted: a file is read only if the folder's own listing holds it, as a regular file of its kind.

const NETWORK = "instagram";
/** Where an export keeps its chats, from its root. */
const MESSAGES = "your_instagram_activity/messages";
/** A chat's folder: a slug of its title (none when the title has no letter to keep), then the chat's export id (Instagram's id for it). */
const CHAT_DIR = /^(?:.*_)?(?<id>\d{5,32})$/;
const MESSAGE_FILE = /^message_\d{1,4}\.json$/;
/** A media file's name: no path in it. */
const FILE_NAME = /^[A-Za-z0-9][\w.-]{0,200}$/;
/** The largest chat file read (the largest seen holds 6,000 messages in 2 MB). */
const MAX_JSON = 64 * 1024 * 1024;
/** How close two times are for one message seen twice with the same words (a bridge stamps its own). */
const SAME_WITHIN = 2000;
/** How many message instants a chat of the archive shares with an export's chat to be the same chat. */
const SAME_CHAT_AT = 3;
/** What the export writes where a reaction was: no message. */
const REACTION_TEXT = /^(Liked a message|Reacted .+ to your message ?)$/;
/** What it writes beside a share or a file: the share or the file says it. */
const ATTACHMENT_TEXT = / sent an attachment\.$/;

const Media = z.array(z.looseObject({ uri: z.string() })).default([]);
const Message = z.looseObject({
  audio_files: Media,
  call_duration: z.number().optional(),
  content: z.string().optional(),
  gifs: Media,
  photos: Media,
  sender_name: z.string(),
  share: z
    .looseObject({
      link: z.string().optional(),
      share_text: z.string().optional(),
    })
    .optional(),
  timestamp_ms: z.int().positive(),
  videos: Media,
});
const Chat = z.looseObject({
  messages: z.array(Message),
  participants: z.array(z.looseObject({ name: z.string() })),
  title: z.string(),
});

/** Whether `folder` is an Instagram export. */
export const isInstagramExport = (folder: string) =>
  existsSync(join(folder, MESSAGES, "inbox"));

/** The export's text as written: Meta writes each UTF-8 byte as one character. */
export const decoded = (s: string) =>
  [...s].every((c) => c.charCodeAt(0) < 256)
    ? Buffer.from(s, "latin1").toString("utf8")
    : s;

const isFile = (path: string) =>
  lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;

/** The names in `dir` that are regular files (a link is not one), or none. */
const filesIn = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir).filter((name) => isFile(join(dir, name)))
    : [];

/** A file of a message: where the export holds it (if it does), and what the archive's row says of it. */
interface ExportFile {
  from?: string;
  mimeType: string;
  name: string;
}
/** One message of an export's chat, as its archive row will say it. */
interface ChatMessage {
  files: ExportFile[];
  isCall: boolean;
  ms: number;
  senderName: string;
  text: string;
}
interface ExportChat {
  id: string;
  messages: ChatMessage[];
  participants: string[];
  title: string;
}

const MIME: Record<string, string> = {
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".webp": "image/webp",
};
/** The export's folder for each kind of file, and the type of one whose extension says nothing (audio is an MP4). */
const KINDS = [
  ["photos", "photos", "image/jpeg"],
  ["videos", "videos", "video/mp4"],
  ["audio_files", "audio", "audio/mp4"],
  ["gifs", "gifs", "image/gif"],
] as const;

/**
 * What a message of the export is worth: nothing for a reaction's line or an empty message; else its words (a share's
 * link after them), whether it is a call's notice (the bridge's own wording), and the files it names, each found by
 * its name alone in the chat's own folder of its kind (`held`).
 */
function messageOf(
  raw: z.infer<typeof Message>,
  held: (kind: string, name: string) => string | undefined
): ChatMessage | undefined {
  const said = decoded(raw.content ?? "");
  if (REACTION_TEXT.test(said)) {
    return;
  }
  const files = KINDS.flatMap(([key, kind, fallback]) =>
    raw[key].flatMap((f): ExportFile[] => {
      const name = basename(f.uri);
      // A name with anything of a path in it is no file of this export.
      return FILE_NAME.test(name)
        ? [
            {
              from: held(kind, name),
              mimeType:
                (kind === "audio" ? undefined : MIME[extname(name)]) ??
                fallback,
              name,
            },
          ]
        : [];
    })
  );
  const text = [
    ATTACHMENT_TEXT.test(said) ? "" : said,
    decoded(raw.share?.share_text ?? ""),
    raw.share?.link ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  const isCall = raw.call_duration !== undefined;
  return text || files.length > 0
    ? {
        files,
        isCall,
        ms: raw.timestamp_ms,
        senderName: decoded(raw.sender_name),
        text,
      }
    : undefined;
}

/** The export's chats, each with its messages oldest first: every `message_N.json` of every chat folder the listing holds. */
export function readExportChats(folder: string): ExportChat[] {
  return ["inbox", "message_requests"].flatMap((box) => {
    const root = join(folder, MESSAGES, box);
    if (!existsSync(root)) {
      return [];
    }
    return readdirSync(root).flatMap((name): ExportChat[] => {
      const id = CHAT_DIR.exec(name)?.groups?.id;
      const dir = join(root, name);
      if (!(id && lstatSync(dir).isDirectory())) {
        return [];
      }
      const held = new Map<string, Set<string>>(
        KINDS.map(([, kind]) => [kind, new Set(filesIn(join(dir, kind)))])
      );
      const parts = filesIn(dir)
        .filter((f) => MESSAGE_FILE.test(f))
        .map((f) => {
          const path = join(dir, f);
          if (lstatSync(path).size > MAX_JSON) {
            throw new Error(`${name}/${f} is too large to be a chat`);
          }
          return Chat.parse(JSON.parse(readFileSync(path, "utf8")));
        });
      const [first] = parts;
      if (!first) {
        return [];
      }
      return [
        {
          id,
          messages: parts
            .flatMap((p) => p.messages)
            .flatMap((m) => {
              const message = messageOf(m, (kind, file) =>
                held.get(kind)?.has(file) ? join(dir, kind, file) : undefined
              );
              return message ? [message] : [];
            })
            .sort((a, b) => a.ms - b.ms),
          participants: first.participants.map((p) => decoded(p.name)),
          title: decoded(first.title),
        },
      ];
    });
  });
}

/** His name in the export: the one participant of every chat. */
function ownerNameOf(chats: ExportChat[]) {
  const among = chats.filter((c) => c.participants.length > 1);
  const names = (among[0]?.participants ?? []).filter((n) =>
    among.every((c) => c.participants.includes(n))
  );
  if (among.length < 2 || names.length !== 1) {
    throw new Error(
      "the export does not say whose it is: no single name is in every chat"
    );
  }
  return names[0] as string;
}

interface Held {
  chat: string;
  fromMe: number;
  ms: number;
  sender: string | null;
  text: string;
}

/** The archive to copy into; for a dry run, which writes nothing (its tables included), the archive as it is, if any. */
function archiveFor(dir: string, dry: boolean | undefined) {
  if (!dry) {
    return openBridged(NETWORK, dir);
  }
  const file = archiveDb(NETWORK, dir);
  return existsSync(file) ? openReadOnly(file) : undefined;
}

/** What the archive holds as read (`AS_READ`): its messages by chat, and its chats by message instant. */
function heldIn(archive: Database | undefined) {
  const held =
    archive
      ?.query<Held, []>(
        `select m.chat, m.fromMe, cast(strftime('%s', m.at) as integer) * 1000 + cast(substr(m.at, 21, 3) as integer) as ms,
            m.sender, m.text
           from messages m where ${AS_READ}`
      )
      .all() ?? [];
  const chatsAt = new Map<number, Set<string>>();
  for (const h of held) {
    chatsAt.set(h.ms, (chatsAt.get(h.ms) ?? new Set()).add(h.chat));
  }
  return { byChat: Map.groupBy(held, (h) => h.chat), chatsAt };
}

/**
 * Where an export's chat lands, the archive's messages of every chat it may be in (`theirs`), and in a one-to-one
 * the other person as the archive names them, when it does.
 */
function placeOf(
  c: ExportChat,
  { byChat, chatsAt }: ReturnType<typeof heldIn>,
  portal: { other: string | null; room: string } | undefined
) {
  const shared = new Map<string, number>();
  for (const m of c.messages) {
    for (const chat of chatsAt.get(m.ms) ?? []) {
      shared.set(chat, (shared.get(chat) ?? 0) + 1);
    }
  }
  const same = [...shared]
    .filter(([, n]) => n >= SAME_CHAT_AT)
    .sort((a, b) => b[1] - a[1])
    .map(([chat]) => chat);
  const landing = portal?.room ?? same[0] ?? c.id;
  const others = new Set(
    (byChat.get(landing) ?? []).flatMap((h) =>
      h.fromMe || !h.sender ? [] : [h.sender]
    )
  );
  const known = portal?.other ?? (others.size === 1 ? [...others][0] : null);
  return {
    landing,
    other: c.participants.length === 2 ? (known ?? undefined) : undefined,
    theirs: [...new Set([portal?.room, ...same, c.id])].flatMap(
      (chat) => (chat && byChat.get(chat)) || []
    ),
  };
}

/** Whether the archive already holds a message: the same side at the same millisecond, or within `SAME_WITHIN` with the same words. */
const isHeld = (theirs: Held[], m: ChatMessage, fromMe: number) =>
  theirs.some(
    (h) =>
      h.fromMe === fromMe &&
      (h.ms === m.ms ||
        (m.text !== "" &&
          h.text === m.text &&
          Math.abs(h.ms - m.ms) <= SAME_WITHIN))
  );

/** A message's files as its archive row says them, and those the export holds with where each clone goes. */
function keptFiles(m: ChatMessage, mediaDir: string) {
  const clones: [to: string, from: string][] = [];
  const row = m.files.map((f, n) => {
    const path = f.from && join(mediaDir, f.name);
    if (f.from && path) {
      clones.push([path, f.from]);
    }
    return {
      fileName: f.name,
      id: `export:${m.ms}/${n + 1}`,
      mimeType: f.mimeType,
      path,
    };
  });
  return { clones, row };
}

/** One export chat as the archive's new rows: its messages the archive does not hold, their files, and the clones to make. */
function chatRows(
  c: ExportChat,
  o: {
    dir: string;
    held: ReturnType<typeof heldIn>;
    owner: string;
    portal: { other: string | null; room: string } | undefined;
    seenAt: string;
  }
) {
  const { landing, other, theirs } = placeOf(c, o.held, o.portal);
  const mediaDir = join(o.dir, "media", NETWORK, "export", c.id);
  const fresh = c.messages.filter(
    (m) => !isHeld(theirs, m, m.senderName === o.owner ? 1 : 0)
  );
  const kept = fresh.map((m) => keptFiles(m, mediaDir));
  return {
    clones: kept.flatMap((k) => k.clones),
    duplicates: c.messages.length - fresh.length,
    files: fresh.flatMap((m, i) =>
      kept[i]?.row.length
        ? [[landing, `export:${m.ms}`, JSON.stringify(kept[i]?.row)]]
        : []
    ),
    missing: kept.flatMap((k) => k.row).filter((f) => !f.path).length,
    photos: kept
      .flatMap((k) => k.row)
      .filter((f) => f.path && f.mimeType.startsWith("image/")).length,
    rows: fresh.map((m) => {
      const fromMe = m.senderName === o.owner ? 1 : 0;
      return [
        ...[m.ms, `export:${m.ms}`, landing, c.title],
        ...[fromMe ? "me" : (other ?? m.senderName), m.senderName, fromMe],
        new Date(m.ms).toISOString(),
        m.isCall ? "m.notice" : "m.text",
        ...[m.text, 0, o.seenAt],
      ];
    }),
  };
}

const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);

/**
 * Brings an Instagram export into the Instagram archive (`dry`: only counts). A chat lands in the bridge's room for
 * it (`portalsOf`, by the chat's export id), else in the chat of the archive that shares `SAME_CHAT_AT` message
 * instants with it (Beeper's copy), else in a chat named by its export id. A message the archive already holds
 * (`isHeld`, in any of those chats) is skipped. In a one-to-one the other person is who the bridge says, else the
 * landing chat's one other sender, else their name as the export shows it; his side is the one name in every chat.
 * Each file the export holds is cloned once into the archive's media, its path in the message's files row.
 * ponytail: two messages of one side in one chat at the same millisecond are one; a message the archive holds over
 * 2 s away or under other words is doubled (about 44 of 1,400 on his archive).
 */
export function copyInstagramExport(
  folder: string,
  o: { archive?: string; bridges?: string; dry?: boolean; now?: number } = {}
) {
  const dir = o.archive ?? ARCHIVE;
  const chats = readExportChats(folder);
  const owner = ownerNameOf(chats);
  const portals = portalsOf(NETWORK, o.bridges ?? BRIDGES);
  const archive = archiveFor(dir, o.dry);
  try {
    const held = heldIn(archive);
    const seenAt = new Date(o.now ?? clock().getTime()).toISOString();
    const made = chats.map((c) =>
      chatRows(c, { dir, held, owner, portal: portals.get(c.id), seenAt })
    );
    const rows = made.flatMap((m) => m.rows);
    const clones = new Map(made.flatMap((m) => m.clones));
    if (!o.dry) {
      for (const [to, from] of clones) {
        if (!existsSync(to)) {
          mkdirSync(dirname(to), { recursive: true });
          copyFileSync(from, to, constants.COPYFILE_FICLONE);
        }
      }
    }
    if (archive && !o.dry) {
      insertVersions(
        archive,
        made.flatMap((m) => m.files),
        rows
      );
    }
    const times = rows.map((r) => r[0] as number).sort((a, b) => a - b);
    const at = (ms: number | undefined) =>
      ms === undefined ? undefined : new Date(ms).toISOString();
    return {
      // What the archive did not hold: a second import of the same export adds none.
      added: rows.length,
      chats: chats.length,
      duplicates: sum(made.map((m) => m.duplicates)),
      files: { kept: clones.size, missing: sum(made.map((m) => m.missing)) },
      first: at(times[0]),
      last: at(times.at(-1)),
      messages: sum(chats.map((c) => c.messages.length)),
      photos: sum(made.map((m) => m.photos)),
    };
  } finally {
    archive?.close();
  }
}
