import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MACHINE_DIR } from "../core/platform";
import { SECRETS } from "../core/secret";
import { openReadOnly } from "../core/sqlite";
import type { Outgoing, Picture, SendPath } from "./contract";
import {
  contentOf,
  featureProblemOf,
  type RoomFeatures,
} from "./matrix-content";

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

/** A YAML file's content, the one reader of bridge and homeserver configs. */
export const readYaml = (path: string) =>
  Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/** A bridge's own config (`config.yaml`), the one place its settings are read from: never copied. */
export const configOf = (bridge: string) =>
  readYaml(join(BRIDGES, bridge, "config.yaml")) as {
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

/** An `mxc://<server>/<id>` file at the homeserver's own copy (`media_store/local_content/<2>/<2>/<rest>`). */
const MXC = /^mxc:\/\/[^/]+\/(.{2})(.{2})(.+)$/;
export const mediaOf = (url: string, synapse = SYNAPSE) => {
  const m = url.match(MXC);
  return m?.[3]
    ? join(
        dirname(synapse),
        "media_store",
        "local_content",
        `${m[1]}`,
        `${m[2]}`,
        m[3]
      )
    : undefined;
};

/**
 * The pictures a bridge's ghosts show (their avatars, kept by the homeserver), from the bridge's own record of each:
 * by Life's senders for its network id (`sendersOf`, by default its localpart, as `bridged.ts` reads a sender) and its
 * username when the bridge keeps one (an export names people by it). None while the bridge isn't on this Mac.
 */
export function ghostPicturesOf(
  bridge: string,
  sendersOf = (id: string) => [localpartOf(id)],
  bridges = BRIDGES,
  synapse = SYNAPSE
): Picture[] {
  return (
    withBridgeDb(
      bridge,
      (db) =>
        db
          .query<{ id: string; metadata: string | null; url: string }, []>(
            "select id, avatar_mxc as url, metadata from ghost where avatar_mxc like 'mxc://%'"
          )
          .all()
          .flatMap((r) => {
            const file = mediaOf(r.url, synapse);
            if (!(file && existsSync(file))) {
              return [];
            }
            const { username } = JSON.parse(r.metadata ?? "{}") as {
              username?: string;
            };
            return [
              {
                bytes: readFileSync(file),
                handles: [...sendersOf(r.id), ...(username ? [username] : [])],
              },
            ];
          }),
      bridges
    ) ?? []
  );
}

/** The homeserver's database opened for `read`; none when it isn't on this Mac. */
export function withHomeserver<T>(synapse: string, read: (hs: Database) => T) {
  if (!existsSync(synapse)) {
    return;
  }
  const hs = openReadOnly(synapse);
  try {
    return read(hs);
  } finally {
    hs.close();
  }
}

/** A bridge's own database (`<bridges>/<bridge>/<bridge>.db`) opened for `read`; none when the bridge isn't on this Mac. */
export function withBridgeDb<T>(
  bridge: string,
  read: (db: Database) => T,
  bridges = BRIDGES
) {
  const file = join(bridges, bridge, `${bridge}.db`);
  if (!existsSync(file)) {
    return;
  }
  const db = openReadOnly(file);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * The rooms on Life's homeserver (a room's id has no server part since room version 12, so only the homeserver can say
 * which are its own); the homeserver is never made again, so the set only grows. One read per call, never per event.
 */
export function readHomeserverRooms(synapse = SYNAPSE) {
  return (
    withHomeserver(synapse, (hs) =>
      hs
        .query<{ room: string }, []>("select room_id as room from rooms")
        .all()
        .map((r) => r.room)
    ) ?? []
  );
}

/**
 * What the bridge says the room takes: the content of its `com.beeper.room_features` state event, none when it never
 * sent one (a room not opened yet). Read from the homeserver, never from a table of ours.
 */
export function roomFeaturesOf(room: string, synapse = SYNAPSE) {
  return withHomeserver(synapse, (hs) => {
    const row = hs
      .query<{ json: string }, [string]>(
        `select j.json from current_state_events c join event_json j on j.event_id = c.event_id
          where c.room_id = ? and c.type = 'com.beeper.room_features' limit 1`
      )
      .get(room);
    return row
      ? (JSON.parse(row.json).content as RoomFeatures | undefined)
      : undefined;
  });
}

/**
 * A Matrix user id's localpart as a bridge writes it from a network id (mautrix's `EncodeUserLocalpart`): lowercase,
 * digits and `-./` kept, an uppercase letter as `_` and itself lowercased, `_` doubled, anything else `=` and its hex.
 */
const KEPT = /[a-z0-9\-./]/;
const UPPER = /[A-Z]/;
export const localpartOf = (id: string) =>
  [...id]
    .map((c) => {
      if (KEPT.test(c)) {
        return c;
      }
      if (UPPER.test(c)) {
        return `_${c.toLowerCase()}`;
      }
      return c === "_"
        ? "__"
        : [...new TextEncoder().encode(c)]
            .map((b) => `=${b.toString(16).padStart(2, "0")}`)
            .join("");
    })
    .join("");

/** The Matrix user a bridge makes for a network user whose id's localpart is `localpart` (its `username_template`, from its own config). */
export const ghostOf = (bridge: string, localpart: string) =>
  userOn(
    (
      configOf(bridge).appservice?.username_template ?? `${bridge}_{{.}}`
    ).replace("{{.}}", localpart)
  );

/** Whether a network's bridge is added: its folder holds its config (`bun life bridge add`). */
export const isBridgeAdded = (network: string) =>
  existsSync(join(BRIDGES, network, "config.yaml"));

/** His logins on a bridge, as its own database holds them (the network's ids); none when the bridge isn't on this Mac. */
export const loginIdsOf = (bridge: string) =>
  withBridgeDb(bridge, (db) =>
    db
      .query<{ id: string }, []>("select id from user_login")
      .all()
      .map((l) => l.id)
  ) ?? [];

/** Whether he has linked a network's bridge: it holds a login. Until then another copier may still be the one reading it. */
export const isBridgeLinked = (network: string) =>
  loginIdsOf(network).length > 0;

/** The bridge's own provisioning secret and address, read from its config: never copied. */
function provisioning(bridge: string) {
  const { appservice, provisioning: p } = configOf(bridge);
  if (!(p?.shared_secret && appservice?.port)) {
    throw new Error(`${bridge}: no provisioning secret or port in its config`);
  }
  return { port: appservice.port, secret: p.shared_secret };
}

/** A hung bridge fails a call after 10 s; a file's upload gets 60 s. */
const CALL_MS = 10_000;
const UPLOAD_MS = 60_000;

async function call(url: string, auth: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(CALL_MS),
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

/** Where a send reaches, and how long it waits: only a test changes it (a send with a file waits 60 s, else 20 s). */
interface SendAt {
  bridges: string;
  confirmMs: number;
  homeserver: string;
  synapse: string;
  token?: string;
}

/**
 * Sends `d` as him into `room` through `bridge`, once per `txn`: joins, uploads a file, puts the event, and waits for
 * the bridge's own record of it (`message`, or `reaction` for a reaction); the event, once the bridge confirmed it.
 * `target` is the event replied or reacted to, `users` the Matrix users mentioned.
 */
async function sendEvent(
  bridge: string,
  room: string,
  d: Outgoing,
  ctx: { target?: string; users: string[] },
  txn: string,
  at: SendAt,
  onHanded?: () => void
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
  // An upload alone sends nothing: whatever fails there, nothing went.
  const mxc = d.file && (await upload(d.file, at));
  const sent = await call(
    `${path}/rooms/${id}/send/${d.reaction ? "m.reaction" : "m.room.message"}/${encodeURIComponent(txn)}`,
    at.token,
    {
      body: JSON.stringify(contentOf(d, { ...ctx, mxc })),
      method: "PUT",
    }
  ).catch((e: Error) => {
    throw new Error(
      REFUSED.test(e.message)
        ? `not sent: the homeserver refused it: ${e.message}`
        : `may have gone: the homeserver didn't answer (${e.message}): read the chat`
    );
  });
  const event = String(sent.event_id);
  onHanded?.();
  const confirmed = () =>
    withBridgeDb(
      bridge,
      (db) =>
        db
          .query(
            `select 1 from ${d.reaction ? "reaction" : "message"} where mxid = ?`
          )
          .get(event),
      at.bridges
    );
  for (let waited = 0; waited < at.confirmMs; waited += 500) {
    if (confirmed()) {
      return event;
    }
    // biome-ignore lint/performance/noAwaitInLoops: polling the bridge's own record
    await Bun.sleep(500);
  }
  throw new Error(
    `may have gone: the homeserver took it (${event}) but the ${bridge} bridge didn't confirm it: read the chat`
  );
}

/** Puts a file in the homeserver's media store: its `mxc://` address. */
async function upload(file: NonNullable<Outgoing["file"]>, at: SendAt) {
  const res = await fetch(
    `${at.homeserver}/_matrix/media/v3/upload?filename=${encodeURIComponent(file.name)}`,
    {
      body: new Blob([file.bytes as BlobPart]),
      headers: {
        Authorization: `Bearer ${at.token}`,
        "Content-Type": file.mime,
      },
      method: "POST",
      signal: AbortSignal.timeout(UPLOAD_MS),
    }
  ).catch((e: Error) => {
    throw new Error(`not sent: the file didn't upload: ${e.message}`);
  });
  const body = (await res.json().catch(() => ({}))) as { content_uri?: string };
  if (!(res.ok && body.content_uri)) {
    throw new Error(`not sent: the homeserver refused the file: ${res.status}`);
  }
  return body.content_uri;
}

/** What the bridge's provisioning says of an identifier (`resolve_identifier`, `create_dm`): the chat's name and room. */
interface Resolved {
  dm_room_mxid?: string;
  name?: string;
}

/** A network's mappings between Life's ids and the bridge's (the defaults are a bridged network's own, `bridged.ts`), and `at`, which only a test sets. */
interface SendOptions {
  at?: Partial<SendAt>;
  /** The Matrix event a message id of Life's names in `chat`, as the bridge holds it; none when it holds none. */
  eventOf?: (
    chat: string,
    id: string,
    bridges: string,
    synapse: string
  ) => string | undefined;
  /** The Matrix user a sender, as Life's events name them, is on the bridge; none for one it can't name. */
  ghostOf?: (sender: string) => string | undefined;
  /** The chat's id the bridge opens a new 1:1 chat by, for a network that has one: asking the bridge to open a chat asks the network whether the handle has an account. */
  handleOf?: (chat: string) => string | undefined;
  /** Life's id for a message the bridge confirmed (`bridges` and `synapse` as `eventOf`), as `read` gives it later; the Matrix event where Life has none. */
  idOf?: (
    chat: string,
    event: string,
    bridges: string,
    synapse: string
  ) => string;
  /** Reads the rooms once and gives a chat's room there (none for a chat the bridge holds no room for). */
  roomsOf: () => (chat: string) => string | undefined;
}

const NUMBER = /^\d+$/;

/**
 * The Matrix event of a bridged message's id of Life's, `<bridge>:<room>/<number>`: the number is the homeserver's own
 * order of the event (`bridged.ts` copies it as the archive's id), and the bridge's own record must hold the event.
 */
function ownEventOf(
  bridge: string,
  chat: string,
  id: string,
  bridges: string,
  synapse: string
) {
  const prefix = `${bridge}:${chat}/`;
  const stream = id.startsWith(prefix) ? id.slice(prefix.length) : "";
  if (!NUMBER.test(stream)) {
    return;
  }
  const event = withHomeserver(
    synapse,
    (hs) =>
      hs
        .query<{ id: string }, [string, number]>(
          "select event_id as id from events where room_id = ? and stream_ordering = ?"
        )
        .get(chat, Number(stream))?.id
  );
  return event &&
    withBridgeDb(
      bridge,
      (db) => db.query("select 1 from message where mxid = ?").get(event),
      bridges
    )
    ? event
    : undefined;
}

/** Life's id for the message the bridge sent as Matrix event `event` (the reverse of `ownEventOf`); the event when the homeserver doesn't hold it. */
function ownIdOf(bridge: string, chat: string, event: string, synapse: string) {
  const stream = withHomeserver(
    synapse,
    (hs) =>
      hs
        .query<{ n: number }, [string]>(
          "select stream_ordering as n from events where event_id = ?"
        )
        .get(event)?.n
  );
  return stream === undefined ? event : `${bridge}:${chat}/${stream}`;
}

/**
 * A network's send path through its bridge, the one Matrix send (`scripts/imports.test.ts`): text, a file, a reply, a
 * reaction, mentions, as each room's own `com.beeper.room_features` allows (`roomFeaturesOf`).
 * A send ends within about 3 minutes (a chat opened, a join and a put of 10 s, an upload of 60 s, a confirmation of 60 s).
 */
export function matrixSend(
  bridge: string,
  {
    at = {},
    eventOf = (chat, id, bridges, synapse) =>
      ownEventOf(bridge, chat, id, bridges, synapse),
    ghostOf: userOf = (sender) => ghostOf(bridge, sender),
    handleOf,
    idOf = (chat, event, _bridges, synapse) =>
      ownIdOf(bridge, chat, event, synapse),
    roomsOf,
  }: SendOptions
): SendPath {
  const handle = (chat: string) => encodeURIComponent(handleOf?.(chat) ?? "");
  const where = (d?: Outgoing): SendAt => ({
    bridges: BRIDGES,
    confirmMs: d?.file ? 60_000 : 20_000,
    homeserver: HOMESERVER_URL,
    synapse: SYNAPSE,
    ...readOwnerAccount(),
    ...at,
  });
  /** What the draft names on the bridge: its target event and its mentioned users, or why it can't. */
  const namedBy = (d: Outgoing, { bridges, synapse }: SendAt) => {
    const target =
      d.onMessage && eventOf(d.chat, d.onMessage, bridges, synapse);
    const users = (d.mentions ?? []).map((m) => userOf(m.sender));
    if (d.onMessage && !target) {
      return "that message isn't one this chat's bridge holds";
    }
    return users.every(Boolean)
      ? { target: target || undefined, users: users as string[] }
      : "a sender it can't mention is named";
  };
  return {
    block: async () =>
      isBridgeAdded(bridge)
        ? await readBlock(bridge)
        : `the ${bridge} bridge isn't on this Mac`,
    holds: (chats) => {
      const roomOf = roomsOf();
      return chats.filter((c) => roomOf(c));
    },
    // Join, upload, put, then the bridge's confirmation.
    limitMs: (d) => 2 * CALL_MS + (d.file ? UPLOAD_MS : 0) + where(d).confirmMs,
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
    refusal: (d) => {
      const room = roomsOf()(d.chat);
      const named = namedBy(d, where(d));
      return Promise.resolve(
        featureProblemOf(
          d,
          room ? roomFeaturesOf(room, where(d).synapse) : undefined
        ) ?? (typeof named === "string" ? named : undefined)
      );
    },
    send: async (d, txn, onHanded) => {
      const w = where(d);
      const named = namedBy(d, w);
      if (typeof named === "string") {
        throw new Error(`not sent: ${named}`);
      }
      let room = roomsOf()(d.chat);
      if (!room && handleOf?.(d.chat)) {
        room = (
          (await provision(bridge, `create_dm/${handle(d.chat)}`, {
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
      const event = await sendEvent(bridge, room, d, named, txn, w, onHanded);
      return d.reaction ? event : idOf(d.chat, event, w.bridges, w.synapse);
    },
  };
}
