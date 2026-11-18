import type { Outgoing } from "./contract";

// What a bridge's room takes, and a draft as the event it becomes (`matrixSend`, `sources/matrix.ts`): both pure.

/**
 * What a room takes, as its bridge states it in the room's `com.beeper.room_features` event (mautrix's `RoomFeatures`,
 * `event/capabilities.go`): a level of 1 or more is supported. The bridge is the one place that knows, per room.
 */
export interface RoomFeatures {
  allowed_reactions?: string[];
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

/** What of a draft's file the room can't take. */
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
  if (d.reaction) {
    if (!takes(f?.reaction)) {
      return "this chat takes no reactions";
    }
    if (
      f?.allowed_reactions?.length &&
      !f.allowed_reactions.includes(d.reaction)
    ) {
      return `this chat takes only these reactions: ${f.allowed_reactions.join(" ")}`;
    }
  } else if (d.onMessage && !takes(f?.reply)) {
    return "this chat takes no replies";
  }
  if (d.mentions && !takes(f?.formatting?.user_link)) {
    return "this chat takes no mentions";
  }
  return fileProblemOf(d, f);
}

const escaped = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\n", "<br>");

/** `text` as HTML with each mention's `@name` (in order) a link to its Matrix user, the rest escaped. */
function htmlOf(text: string, names: string[], users: string[]) {
  let at = 0;
  let html = "";
  names.forEach((name, i) => {
    const from = text.indexOf(`@${name}`, at);
    html += `${escaped(text.slice(at, from))}<a href="https://matrix.to/#/${escaped(users[i] ?? "")}">@${escaped(name)}</a>`;
    at = from + name.length + 1;
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
          formatted_body: htmlOf(
            d.text,
            d.mentions.map((m) => m.name),
            users
          ),
          "m.mentions": { user_ids: users },
        }
      : {}),
    ...(target
      ? { "m.relates_to": { "m.in_reply_to": { event_id: target } } }
      : {}),
  };
}
