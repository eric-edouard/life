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
/** A Telegram username, `@` or not: what `t.me/<username>` opens. */
const TELEGRAM_USERNAME = /^@?[A-Za-z]\w{3,31}$/;

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
 * what he calls it, the bridge's repository and command to build, how its notices say a call (`callOf`), the config keys he must fill in himself (`appKeys`), the bridge's login flow he signs in with, from his phone or the CLI
 * (`loginFlow`, required: `networks.test.ts`), and whether its app is what Life reads (`readByItsApp`: WhatsApp's). The one list.
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
    integration: {
      privacy:
        "Signed in through Life's bridge on this computer: your LINE messages come straight to it, then what Life reads goes to the AI you chose.",
      requirements: [],
      value: {
        answer: "Ana sent the times for Saturday's train in the group.",
        ask: "What did Ana say about the trip?",
      },
    },
    label: "LINE",
    loginFlow: "dev.highest.matrix.line.email_login",
    name: "line",
    repo: "beeper/line",
  },
  {
    callOf: metaCallOf,
    cmd: "cmd/mautrix-instagram",
    integration: {
      privacy:
        "Signed in through Life's bridge on this computer: your Instagram messages come straight to it, then what Life reads goes to the AI you chose.",
      requirements: [],
      value: {
        answer: "Sam's post: boxes packed, moving on Sunday.",
        ask: "What did Sam post about the move?",
      },
    },
    label: "Instagram",
    loginFlow: "instagram",
    name: "instagram",
    repo: "mautrix/meta",
  },
  {
    // ponytail: Instagram's call notices assumed; a Messenger call in another wording stays a plain notice until seen.
    callOf: metaCallOf,
    cmd: "cmd/mautrix-meta",
    integration: {
      privacy:
        "Signed in through Life's bridge on this computer: your Messenger messages come straight to it, then what Life reads goes to the AI you chose.",
      requirements: [],
      value: {
        answer: "Ana wrote in the group: dinner at 8, her place.",
        ask: "What did Ana plan for Friday?",
      },
    },
    label: "Messenger",
    loginFlow: "facebook",
    name: "messenger",
    repo: "mautrix/meta",
  },
  {
    // Its bridge exits until its config holds his own keys from my.telegram.org (`bun life bridge link`).
    appKeys: {
      hint: "Get them at https://my.telegram.org → API development tools (log in with your phone number).",
      opens: "https://my.telegram.org",
      paths: ["network.api_id", "network.api_hash"],
      secret: ["network.api_hash"],
    },
    // A username opens its chat; a numeric id opens nothing.
    chatLinkOf: (handle: string) =>
      TELEGRAM_USERNAME.test(handle)
        ? `https://t.me/${handle.replace("@", "")}`
        : undefined,
    cmd: "cmd/mautrix-telegram",
    integration: {
      privacy:
        "Signed in through Life's bridge on this computer: your Telegram messages come straight to it, then what Life reads goes to the AI you chose.",
      requirements: [],
      value: {
        answer: "Sam's message: the link to the new docs, on Tuesday.",
        ask: "What did Sam send in the channel?",
      },
    },
    label: "Telegram",
    loginFlow: "phone",
    name: "telegram",
    repo: "mautrix/telegram",
  },
  {
    cmd: "cmd/mautrix-linkedin",
    integration: {
      privacy:
        "Signed in through Life's bridge on this computer: your LinkedIn messages come straight to it, then what Life reads goes to the AI you chose.",
      requirements: [],
      value: {
        answer: "Two people replied; Ana asked about the role you posted.",
        ask: "Who replied to my post?",
      },
    },
    label: "LinkedIn",
    loginFlow: "cookies",
    name: "linkedin",
    repo: "mautrix/linkedin",
  },
  {
    cmd: "cmd/mautrix-whatsapp",
    integration: {
      privacy:
        "Read from the WhatsApp app on this Mac; its bridge on this computer only sends what you approve. What Life reads goes to the AI you chose.",
      requirements: [{ check: "full_disk_access", kind: "permission" }],
      value: {
        answer: "Sam's message from Tuesday: dinner at 8, his place.",
        ask: "What did Sam say about Saturday?",
      },
    },
    label: "WhatsApp",
    loginFlow: "phone",
    name: "whatsapp",
    // Its reading stays the Mac app's source (`sources/whatsapp.ts`); the bridge is how Life sends and opens chats.
    readByItsApp: true,
    repo: "mautrix/whatsapp",
  },
] as const satisfies readonly ({ loginFlow: string } & Record<
  string,
  unknown
>)[];
// The literal entries keep their names typed; a network with no calls has no `callOf`.
export type Network = (typeof NETWORKS)[number] & {
  appKeys?: {
    hint: string;
    /** The page where the keys are made. */
    opens: string;
    paths: readonly string[];
    secret: readonly string[];
  };
  callOf?: (text: string) => CallNotice | undefined;
  chatLinkOf?: (handle: string) => string | undefined;
  readByItsApp?: true;
};
