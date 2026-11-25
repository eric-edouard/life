import { takesProblemOf } from "./chat-takes";
import type { ChatTakes, Outgoing } from "./contract";

// What a bridge's room takes, and a draft as the event it becomes (`matrixSend`, `sources/matrix.ts`): both pure.

/**
 * What a room takes, as its bridge states it in the room's `com.beeper.room_features` event (mautrix's `RoomFeatures`,
 * `event/capabilities.go`): a level of 1 or more is supported. The bridge is the one place that knows, per room.
 */
export interface RoomFeatures {
  allowed_reactions?: string[];
  /** Whether a message may be deleted for everyone, and up to how old, in seconds (none: any age). */
  delete?: number;
  delete_max_age?: number;
  /** By the message type a file goes as (`msgtypeOf`). */
  file?: Record<
    string,
    {
      caption?: number;
      max_size?: number;
      /** By mime type; a wildcard (`image` of any subtype, then any type) counts too. */
      mime_types?: Record<string, number>;
    }
  >;
  formatting?: Record<string, number>;
  reaction?: number;
  reply?: number;
}

const takes = (level?: number) => (level ?? 0) >= 1;

/** The message type a file goes as. */
export function msgtypeOf(mime: string) {
  const [kind] = mime.split("/");
  return kind === "image" || kind === "video" || kind === "audio"
    ? `m.${kind}`
    : "m.file";
}

/** What a room takes besides text, from its features: none of it when its bridge never said. */
export function chatTakesOf(f?: RoomFeatures): ChatTakes {
  return {
    file: Object.values(f?.file ?? {}).some((ff) =>
      Object.values(ff.mime_types ?? {}).some(takes)
    ),
    mentions: takes(f?.formatting?.user_link),
    reaction:
      takes(f?.reaction) &&
      (f?.allowed_reactions?.length ? f.allowed_reactions : true),
    reply: takes(f?.reply),
  };
}

/** What of a draft's file the room can't take: its kind, its size, words with it. */
function fileProblemOf(d: Outgoing, f?: RoomFeatures) {
  if (!d.file) {
    return;
  }
  const ff = f?.file?.[msgtypeOf(d.file.mime)];
  const types = ff?.mime_types ?? {};
  const level =
    types[d.file.mime] ??
    types[`${d.file.mime.split("/")[0]}/*`] ??
    types["*/*"];
  if (!(ff && takes(level))) {
    return `this chat takes no ${d.file.mime} files`;
  }
  if (ff.max_size && d.file.bytes.length > ff.max_size) {
    return `this chat takes files up to ${ff.max_size} bytes`;
  }
  if (d.text && !takes(ff.caption)) {
    return "this chat takes no caption on a file: send the text as its own card";
  }
}

/** What of a draft the room can't take, in words for the asking agent; none when it takes all of it. */
export function featureProblemOf(d: Outgoing, f?: RoomFeatures) {
  if (!f && (d.onMessage || d.file || d.mentions)) {
    return "this chat takes text only: its bridge hasn't said what else it takes (a chat opened and used on the bridge does)";
  }
  return takesProblemOf(d, chatTakesOf(f)) ?? fileProblemOf(d, f);
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Where each mention's `@name` stands in `text`, in order: each searched after the one before, and a name only whole
 * (`@Ann` isn't in `@Anna`). A mention with none is missing from the end of the list. The one place that finds them:
 * the rules and the message sent both use it, so they never disagree.
 */
export function mentionsAt(text: string, mentions: { name: string }[]) {
  const found: { at: number; length: number }[] = [];
  let from = 0;
  for (const m of mentions) {
    const tag = `@${m.name}`;
    let at = text.indexOf(tag, from);
    while (at >= 0 && WORD_CHAR.test(text[at + tag.length] ?? "")) {
      at = text.indexOf(tag, at + 1);
    }
    if (at < 0) {
      break;
    }
    found.push({ at, length: tag.length });
    from = at + tag.length;
  }
  return found;
}

const escaped = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\n", "<br>");

/** `text` as HTML with each mention's `@name` (found by `mentionsAt`) a link to its Matrix user, the rest escaped. */
function htmlOf(text: string, mentions: { name: string }[], users: string[]) {
  let at = 0;
  let html = "";
  mentionsAt(text, mentions).forEach((m, i) => {
    html += `${escaped(text.slice(at, m.at))}<a href="https://matrix.to/#/${escaped(users[i] ?? "")}">${escaped(text.slice(m.at, m.at + m.length))}</a>`;
    at = m.at + m.length;
  });
  return html + escaped(text.slice(at));
}

/**
 * The event content a draft becomes: a reaction on `target`; else a text or a file (its caption in `body`, its name in
 * `filename`, uploaded as `mxc`), replying to `target` when it is one, with its `users` (the Matrix users mentioned)
 * as links in `formatted_body` and in `m.mentions`.
 */
export function contentOf(
  d: Outgoing,
  { mxc, target, users }: { mxc?: string; target?: string; users: string[] }
) {
  if (d.reaction) {
    return {
      "m.relates_to": {
        event_id: target,
        key: d.reaction,
        rel_type: "m.annotation",
      },
    };
  }
  return {
    body: d.text ?? d.file?.name,
    ...(d.file
      ? {
          filename: d.file.name,
          info: { mimetype: d.file.mime, size: d.file.bytes.length },
          msgtype: msgtypeOf(d.file.mime),
          url: mxc,
        }
      : { msgtype: "m.text" }),
    ...(d.text && d.mentions
      ? {
          format: "org.matrix.custom.html",
          formatted_body: htmlOf(d.text, d.mentions, users),
          "m.mentions": { user_ids: users },
        }
      : {}),
    ...(target
      ? { "m.relates_to": { "m.in_reply_to": { event_id: target } } }
      : {}),
  };
}
