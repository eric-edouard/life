import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MACHINE_DIR } from "../core/platform";
import { SECRETS } from "../core/secret";
import { openReadOnly } from "../core/sqlite";
import type { SendPath } from "./contract";

// The bridges' local Matrix homeserver (docs/use/bridges.md): each bridge's config and its provisioning API, which
// says whether it is linked and connected, and the one Matrix send into a bridged chat (`matrixSend`). Reading the
// bridges' messages is `sources/bridged.ts`.

/** Each bridge's folder: its config (the provisioning secret), its database (its rooms); and the homeserver's. */
export const BRIDGES = join(MACHINE_DIR, "bridges");
/** The homeserver's name: every user id on it ends `:life.local`. */
export const SERVER = "life.local";
/** His account on the homeserver. */
export const OWNER = `@owner:${SERVER}`;
/** A Matrix user id on the homeserver. */
export const userOn = (localpart: string) => `@${localpart}:${SERVER}`;

/** A bridge's own config (`config.yaml`), the one place its settings are read from: never copied. */
export const configOf = (bridge: string) =>
  Bun.YAML.parse(
    readFileSync(join(BRIDGES, bridge, "config.yaml"), "utf8")
  ) as {
    appservice?: {
      bot?: { username?: string };
      port?: number;
      username_template?: string;
    };
    provisioning?: { shared_secret?: string };
  };
/** The homeserver's address on this Mac. */
export const HOMESERVER_URL = "http://127.0.0.1:8008";

/** His account on the homeserver as `bun life bridge` saved it (`SECRETS.matrix`); empty before it is set up. */
export const readOwnerAccount = (): { password?: string; token?: string } =>
  existsSync(SECRETS.matrix)
    ? JSON.parse(readFileSync(SECRETS.matrix, "utf8"))
    : {};

/** The homeserver's database. */
export const SYNAPSE = join(BRIDGES, "synapse", "homeserver.db");

/**
 * The rooms on Life's homeserver (a room's id has no server part since room version 12, so only the homeserver can say
 * which are its own); the homeserver is never made again, so the set only grows. One read per call, never per event.
 */
export function readHomeserverRooms(synapse = SYNAPSE) {
  if (!existsSync(synapse)) {
    return [];
  }
  const hs = openReadOnly(synapse);
  try {
    return hs
      .query<{ room: string }, []>("select room_id as room from rooms")
      .all()
      .map((r) => r.room);
  } finally {
    hs.close();
  }
}

/** Whether a network's bridge is added: its folder holds its config (`bun life bridge add`). */
export const isBridgeAdded = (network: string) =>
  existsSync(join(BRIDGES, network, "config.yaml"));

/** The bridge's own provisioning secret and address, read from its config: never copied. */
function provisioning(bridge: string) {
  const { appservice, provisioning: p } = configOf(bridge);
  if (!(p?.shared_secret && appservice?.port)) {
    throw new Error(`${bridge}: no provisioning secret or port in its config`);
  }
  return { port: appservice.port, secret: p.shared_secret };
}

async function call(url: string, auth: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    // A hung bridge fails the call after 10 s.
    signal: AbortSignal.timeout(10_000),
    ...init,
    headers: {
      Authorization: `Bearer ${auth}`,
      "Content-Type": "application/json",
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`${res.status} ${body.error ?? body.errcode ?? url}`);
  }
  return body;
}

/** A call to the bridge's provisioning API, as him. */
function provision(bridge: string, path: string, init: RequestInit = {}) {
  const { port, secret } = provisioning(bridge);
  return call(
    `http://127.0.0.1:${port}/_matrix/provision/v3/${path}?user_id=${encodeURIComponent(OWNER)}`,
    secret,
    init
  );
}

// The bridge states it comes back from by itself: not a block.
const PASSING = [
  "CONNECTED",
  "CONNECTING",
  "BACKFILLING",
  "TRANSIENT_DISCONNECT",
];

/** One of his logins on a bridge, with the state it last reported (none yet just after a start). */
interface Login {
  state?: { message?: string; state_event?: string };
}

/** Why a bridge with these logins isn't working: never linked, or a login in a state it won't leave by itself. */
export function blockOf(bridge: string, logins: Login[]) {
  if (logins.length === 0) {
    return `${bridge} bridge not linked: bun life bridge link ${bridge}`;
  }
  const down = logins.find(
    (l) => !PASSING.includes(l.state?.state_event ?? "")
  );
  return down
    ? `${bridge} bridge ${down.state?.state_event ?? "unknown"}${down.state?.message ? `: ${down.state.message}` : ""}`
    : undefined;
}

/** Whether each login has reported a state: just after a start one has none yet, which `blockOf` would read as down. */
export const hasStates = (logins: Login[]) =>
  logins.every((l) => l.state?.state_event);

/** His logins, as the bridge itself says; throws when it isn't answering. 3 s: the status snapshot waits for it. */
export const readLogins = async (bridge: string) =>
  ((await provision(bridge, "whoami", { signal: AbortSignal.timeout(3000) }))
    .logins ?? []) as Login[];

/**
 * Why the bridge isn't working now, as the bridge itself says (its logins and their state): not running, never linked,
 * or a login that isn't connected. None when it is.
 */
export async function readBlock(bridge: string) {
  try {
    return blockOf(bridge, await readLogins(bridge));
  } catch (e) {
    return `${bridge} bridge not answering: ${(e as Error).message}`;
  }
}

/** One step of a bridge's login, as its provisioning API gives it (mautrix's bridgev2 `LoginStep`). */
export interface LoginStep {
  complete?: { user_login_id?: string };
  cookies?: {
    /** A script the sign-in page runs: it resolves to some of the fields' values (a `special` source names one). */
    extract_js?: string;
    fields?: {
      id: string;
      required?: boolean;
      sources?: {
        cookie_domain?: string;
        name: string;
        request_url_regex?: string;
        type: string;
      }[];
    }[];
    url?: string;
    /** The browser the bridge's own requests claim to be: cookies signed in as another one are revoked as stolen. */
    user_agent?: string;
    /** The page to have reached before the window closes (past 2FA). */
    wait_for_url_pattern?: string;
  };
  display_and_wait?: { data?: string; type?: string };
  instructions?: string;
  login_id: string;
  step_id: string;
  type: "complete" | "cookies" | "display_and_wait" | "user_input";
  user_input?: {
    fields?: {
      description?: string;
      id: string;
      name?: string;
      type?: string;
    }[];
  };
}

/**
 * What a login asks of him: to look at something (a QR code, a code), a site's cookies (all at once), and one value (a
 * field, a cookie that didn't come with the rest).
 */
export interface LoginAsk {
  /** A cookie step's values by field, as he gives them: a browser he signs in to, or a request he pastes. */
  cookies: (step: CookieStep) => Promise<Map<string, string>>;
  show: (step: LoginStep) => void;
  value: (field: { hidden: boolean; id: string; name: string }) => string;
}

export type CookieStep = NonNullable<LoginStep["cookies"]>;

// A curl argument as Chrome and Safari copy it: '…', "…", or $'…' (bash's escapes, when a value holds ! ' or a control).
const ARGUMENT = String.raw`(\$?)(['"])((?:\\.|(?!\2).)*)\2`;
const HEADER = new RegExp(String.raw`(?:-H|--header)\s+${ARGUMENT}`, "g");
const COOKIE_FLAG = new RegExp(String.raw`(?:-b|--cookie)\s+${ARGUMENT}`, "g");
const ESCAPE = /\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g;

/** An argument's text: a $'…' one with its escapes undone (\', \\, \n, \xHH, \uHHHH). */
const unquote = (ansi: string, body: string) =>
  ansi
    ? body.replace(ESCAPE, (_, e: string) => {
        if (e.length > 1) {
          return String.fromCharCode(Number.parseInt(e.slice(1), 16));
        }
        return e === "n" ? "\n" : e;
      })
    : body;

/**
 * A request he pasted, as its cookies and headers by name: a "Copy as cURL" (its `Cookie` header or `-b`), or a JSON
 * object of names and values. Nothing for anything else.
 */
export function pastedValues(pasted: string) {
  const text = pasted.trim();
  if (text.startsWith("{")) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      return {
        cookies: new Map(Object.entries(json).map(([k, v]) => [k, String(v)])),
        headers: new Map<string, string>(),
      };
    } catch {
      // Not JSON after all: read it as a request.
    }
  }
  const headers = new Map(
    [...text.matchAll(HEADER)].flatMap((m) => {
      const header = unquote(`${m[1]}`, `${m[3]}`);
      const at = header.indexOf(":");
      return at > 0
        ? [
            [
              header.slice(0, at).trim().toLowerCase(),
              header.slice(at + 1).trim(),
            ] as const,
          ]
        : [];
    })
  );
  const jar = [
    headers.get("cookie") ?? "",
    ...[...text.matchAll(COOKIE_FLAG)].map((m) =>
      unquote(`${m[1]}`, `${m[3]}`)
    ),
  ]
    .join(";")
    .split(";")
    .map((c) => c.trim().split("="))
    .filter(([name]) => name);
  const cookies = new Map(
    jar.map(([name, ...value]) => [`${name}`, value.join("=")])
  );
  return { cookies, headers };
}

/** Each cookie field's value from what he pasted: by its sources (a cookie, a request header). */
export function cookieValues(
  fields: NonNullable<CookieStep["fields"]>,
  pasted: ReturnType<typeof pastedValues>
) {
  return new Map(
    fields.flatMap((f) => {
      const value = [...(f.sources ?? []), { name: f.id, type: "cookie" }]
        .map((s) =>
          s.type === "request_header"
            ? pasted.headers.get(s.name.toLowerCase())
            : pasted.cookies.get(s.name)
        )
        .find(Boolean);
      return value ? [[f.id, value] as const] : [];
    })
  );
}

/** The ways a bridge offers to link it (QR, email and password, cookies). */
export const loginFlows = async (bridge: string) =>
  ((await provision(bridge, "login/flows")).flows ?? []) as {
    description: string;
    id: string;
    name: string;
  }[];

/** What a step asks him to give: its fields, a password hidden; none for one he looks at. */
function fieldsOf(step: LoginStep) {
  if (step.type === "user_input") {
    return (step.user_input?.fields ?? []).map((f) => ({
      hidden: f.type === "password",
      id: f.id,
      name: f.name ?? f.id,
    }));
  }
  return [];
}

/**
 * What one step sends back: his answers to its fields, or its cookies, all at once first (`ask.cookies`), then one by
 * one for a required one that didn't come (an optional one is left out).
 */
async function answersOf(step: LoginStep, ask: LoginAsk) {
  if (step.type !== "cookies") {
    return Object.fromEntries(fieldsOf(step).map((f) => [f.id, ask.value(f)]));
  }
  const found = await ask.cookies(step.cookies ?? {});
  for (const f of (step.cookies?.fields ?? []).filter(
    (x) => x.required && !found.has(x.id)
  )) {
    found.set(f.id, ask.value({ hidden: true, id: f.id, name: f.id }));
  }
  return Object.fromEntries(found);
}

/**
 * Links the bridge to his account by `flow`, step by step through `ask`, until it is linked; throws what the bridge
 * refused. A step that waits on him (a QR scan) may take minutes.
 */
export async function linkBridge(bridge: string, flow: string, ask: LoginAsk) {
  const long = { signal: AbortSignal.timeout(10 * 60_000) };
  let step = (await provision(bridge, `login/start/${flow}`, {
    ...long,
    body: "{}",
    method: "POST",
  })) as unknown as LoginStep;
  while (step.type !== "complete") {
    ask.show(step);
    // biome-ignore lint/performance/noAwaitInLoops: each step follows the last
    const body = await answersOf(step, ask);
    step = (await provision(
      bridge,
      `login/step/${step.login_id}/${step.step_id}/${step.type}`,
      { ...long, body: JSON.stringify(body), method: "POST" }
    )) as unknown as LoginStep;
  }
  return step.complete?.user_login_id;
}

/** Logs every login of his on the bridge out. */
export async function unlinkBridge(bridge: string) {
  const who = await provision(bridge, "whoami");
  for (const l of (who.logins ?? []) as { id: string }[]) {
    // biome-ignore lint/performance/noAwaitInLoops: one logout at a time
    await provision(bridge, `logout/${encodeURIComponent(l.id)}`, {
      method: "POST",
    });
  }
}

/** A refusal before the homeserver stored anything: a 4xx. A 5xx may come after it stored the event. */
const REFUSED = /^4\d\d /;

/** Where a send reaches, and how long it waits: only a test changes it. */
interface SendAt {
  bridges: string;
  confirmMs: number;
  homeserver: string;
  token?: string;
}

/** Sends `text` as him into `room` through `bridge`, once per `txn`; the event, once the bridge confirmed it. */
async function sendText(
  bridge: string,
  room: string,
  text: string,
  txn: string,
  at: SendAt
) {
  if (!at.token) {
    throw new Error("not sent: the homeserver holds no account of his");
  }
  const path = `${at.homeserver}/_matrix/client/v3`;
  const id = encodeURIComponent(room);
  // He is only invited to most rooms the bridges made: joining is the same call whether or not he is in.
  await call(`${path}/join/${id}`, at.token, {
    body: "{}",
    method: "POST",
  }).catch((e: Error) => {
    throw new Error(`not sent: ${bridge} room not joined: ${e.message}`);
  });
  const sent = await call(
    `${path}/rooms/${id}/send/m.room.message/${encodeURIComponent(txn)}`,
    at.token,
    { body: JSON.stringify({ body: text, msgtype: "m.text" }), method: "PUT" }
  ).catch((e: Error) => {
    throw new Error(
      REFUSED.test(e.message)
        ? `not sent: the homeserver refused it: ${e.message}`
        : `may have gone: the homeserver didn't answer (${e.message}): read the chat`
    );
  });
  const event = String(sent.event_id);
  const db = openReadOnly(join(at.bridges, bridge, `${bridge}.db`));
  try {
    const row = db.query<{ n: number }, [string]>(
      "select 1 as n from message where mxid = ?"
    );
    for (let waited = 0; waited < at.confirmMs; waited += 500) {
      if (row.get(event)) {
        return event;
      }
      // biome-ignore lint/performance/noAwaitInLoops: polling the bridge's own record
      await Bun.sleep(500);
    }
  } finally {
    db.close();
  }
  throw new Error(
    `may have gone: the homeserver took it (${event}) but the ${bridge} bridge didn't confirm it: read the chat`
  );
}

/** What the bridge's provisioning says of an identifier (`resolve_identifier`, `create_dm`): the chat's name and room. */
interface Resolved {
  dm_room_mxid?: string;
  name?: string;
}

/**
 * A network's send path through its bridge, the one Matrix send (`scripts/imports.test.ts`). `roomsOf` reads the rooms
 * once and gives a chat's room there (none for a chat the bridge holds no room for); `handleOf` gives the id the bridge
 * opens a new 1:1 chat by, for a network that has one: asking the bridge to open a chat asks the network whether the
 * handle has an account. A send ends within about 50 s (a chat opened, two calls of 10 s, then 20 s).
 */
export function matrixSend(
  bridge: string,
  roomsOf: () => (chat: string) => string | undefined,
  handleOf?: (chat: string) => string | undefined,
  override: Partial<SendAt> = {}
): SendPath {
  const handle = (chat: string) => encodeURIComponent(handleOf?.(chat) ?? "");
  return {
    block: async () =>
      isBridgeAdded(bridge)
        ? await readBlock(bridge)
        : `the ${bridge} bridge isn't on this Mac`,
    holds: (chats) => {
      const roomOf = roomsOf();
      return chats.filter((c) => roomOf(c));
    },
    opens: handleOf
      ? async (chat) => {
          if (!handleOf(chat)) {
            return;
          }
          try {
            const who = (await provision(
              bridge,
              `resolve_identifier/${handle(chat)}`
            )) as Resolved;
            return who.name ?? handleOf(chat);
          } catch (e) {
            // The bridge's answer for a handle the network has no account for.
            if ((e as Error).message.startsWith("404 ")) {
              return;
            }
            throw e;
          }
        }
      : undefined,
    send: async ({ chat, text }, txn) => {
      let room = roomsOf()(chat);
      if (!room && handleOf?.(chat)) {
        room = (
          (await provision(bridge, `create_dm/${handle(chat)}`, {
            body: "{}",
            method: "POST",
          }).catch((e: Error) => {
            throw new Error(
              `not sent: ${bridge} chat not opened: ${e.message}`
            );
          })) as Resolved
        ).dm_room_mxid;
      }
      if (!room) {
        throw new Error(`not sent: ${bridge} holds no room for this chat`);
      }
      return sendText(bridge, room, text, txn, {
        bridges: BRIDGES,
        confirmMs: 20_000,
        homeserver: HOMESERVER_URL,
        ...readOwnerAccount(),
        ...override,
      });
    },
  };
}
