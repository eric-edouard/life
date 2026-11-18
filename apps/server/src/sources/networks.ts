// Every network on a bridge, and how a bridge's notices say a call (`bun life bridge`, docs/use/bridges.md).

/** What a bridge's notice says of a call: it started (its end comes later), it ended, or the whole call. */
export interface CallNotice {
  ends?: true;
  seconds?: number;
  video: boolean;
}

const META_CALL =
  /^(?:(?<missed>You missed)|.+ started) an? (?<kind>audio call|video chat)$|^(?<ended>Audio call|Video chat) ended$/;
// The length's form is the bridge's (`Voice call (5m33s)`, seen Nov 2026); the notice's time is taken as the call's.
const LINE_CALL =
  /^(?<missed>Missed )?(?<kind>[Vv]oice|[Vv]ideo) call(?: \((?:(?<h>\d+)h)?(?:(?<m>\d+)m)?(?<s>\d+)s\))?$/;

const VIDEO = /video/i;

/** A call in the notices of Meta's bridge (Instagram, Messenger): its start, its end, or a missed one. */
function metaCallOf(text: string): CallNotice | undefined {
  const g = META_CALL.exec(text)?.groups;
  if (!g) {
    return undefined;
  }
  const video = VIDEO.test(g.kind ?? g.ended ?? "");
  if (g.ended) {
    return { ends: true, video };
  }
  return g.missed ? { seconds: 0, video } : { video };
}

/**
 * Every network on a bridge (`bun life bridge`, docs/use/bridges.md), each a source of its own (`memory/sources.ts`):
 * what he calls it, the bridge's repository and command to build, how its notices say a call (`callOf`), the config keys he must fill in himself (`appKeys`), and whether its
 * app is what Life reads (`readByItsApp`: WhatsApp's). The one list.
 */
export const NETWORKS = [
  {
    callOf: (text: string): CallNotice | undefined => {
      const g = LINE_CALL.exec(text)?.groups;
      if (!g || (!g.missed && g.s === undefined)) {
        return undefined;
      }
      const seconds = g.missed
        ? 0
        : Number(g.h ?? 0) * 3600 + Number(g.m ?? 0) * 60 + Number(g.s);
      return { seconds, video: VIDEO.test(g.kind ?? "") };
    },
    cmd: "cmd/matrix-line",
    label: "LINE",
    name: "line",
    repo: "beeper/line",
  },
  {
    callOf: metaCallOf,
    cmd: "cmd/mautrix-instagram",
    label: "Instagram",
    name: "instagram",
    repo: "mautrix/meta",
  },
  {
    // ponytail: Instagram's call notices assumed; a Messenger call in another wording stays a plain notice until seen.
    callOf: metaCallOf,
    cmd: "cmd/mautrix-meta",
    label: "Messenger",
    name: "messenger",
    repo: "mautrix/meta",
  },
  {
    // Its bridge exits until its config holds his own keys from my.telegram.org (`bun life bridge link`).
    appKeys: {
      hint: "Get them at https://my.telegram.org → API development tools (log in with your phone number).",
      paths: ["network.api_id", "network.api_hash"],
      secret: ["network.api_hash"],
    },
    cmd: "cmd/mautrix-telegram",
    label: "Telegram",
    name: "telegram",
    repo: "mautrix/telegram",
  },
  {
    cmd: "cmd/mautrix-linkedin",
    label: "LinkedIn",
    name: "linkedin",
    repo: "mautrix/linkedin",
  },
  {
    cmd: "cmd/mautrix-whatsapp",
    label: "WhatsApp",
    name: "whatsapp",
    // Its reading stays the Mac app's source (`sources/whatsapp.ts`); the bridge is how Life sends and opens chats.
    readByItsApp: true,
    repo: "mautrix/whatsapp",
  },
] as const;
// The literal entries keep their names typed; a network with no calls has no `callOf`.
export type Network = (typeof NETWORKS)[number] & {
  appKeys?: {
    hint: string;
    paths: readonly string[];
    secret: readonly string[];
  };
  callOf?: (text: string) => CallNotice | undefined;
  readByItsApp?: true;
};
