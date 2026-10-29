import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MACHINE_DIR } from "../core/platform";
import { SECRETS } from "../core/secret";
import { openReadOnly } from "../core/sqlite";

// The bridges' local Matrix homeserver (docs/use/bridges.md): a send goes from the owner's Matrix account into the
// bridge's room for the chat, and the bridge passes it to the network as him. Reading the bridges' messages is
// `sources/bridged.ts`.

/** Each bridge's folder: its config (the provisioning secret), its database (its rooms); and the homeserver's. */
export const BRIDGES = join(MACHINE_DIR, "bridges");
/** The homeserver's name: every id on it ends `:life.local`. */
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
/** The homeserver's address on this Mac, and its client API. */
export const HOMESERVER_URL = "http://127.0.0.1:8008";
const HOMESERVER = `${HOMESERVER_URL}/_matrix/client/v3`;

/** His account on the homeserver, written when the bridges were set up (docs/use/bridges.md). */
const owner = () =>
  JSON.parse(readFileSync(SECRETS.matrix, "utf8")) as { token: string };

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
    // A hung bridge fails the call after 10 s. A send that timed out after the homeserver took it is safe to try again:
    // its `txn` makes the second one a no-op.
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

/** A room the bridge already made for the chat (a group: it makes one when a message comes in). */
function knownRoom(bridge: string, chat: string) {
  const path = join(BRIDGES, bridge, `${bridge}.db`);
  if (!existsSync(path)) {
    return;
  }
  const db = openReadOnly(path);
  try {
    return (
      db
        .query<{ mxid: string }, [string]>(
          "select mxid from portal where id = ? and mxid is not null"
        )
        .get(chat)?.mxid ?? undefined
    );
  } finally {
    db.close();
  }
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

/** Why a bridge with these logins can't send: never linked, or a login in a state it won't leave by itself. */
export function blockOf(
  bridge: string,
  logins: { state?: { message?: string; state_event?: string } }[]
) {
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

/**
 * Why the bridge can't send now, as the bridge itself says (its logins and their state): not running, never linked,
 * or a login that isn't connected. None when it can.
 */
async function readBlock(bridge: string) {
  try {
    // 3 s: the status snapshot waits for it.
    const who = await provision(bridge, "whoami", {
      signal: AbortSignal.timeout(3000),
    });
    return blockOf(bridge, (who.logins ?? []) as Parameters<typeof blockOf>[1]);
  } catch (e) {
    return `${bridge} bridge not answering: ${(e as Error).message}`;
  }
}

/** The bridge's room for a chat: the one it has, else a direct chat it opens with that person (idempotent). */
async function roomOf(bridge: string, chat: string) {
  // A bridged source's chat is its Matrix room already (`sources/bridged.ts`).
  if (chat.startsWith("!")) {
    return chat;
  }
  const known = knownRoom(bridge, chat);
  if (known) {
    return known;
  }
  const made = await provision(
    bridge,
    `create_dm/${encodeURIComponent(chat)}`,
    {
      method: "POST",
    }
  );
  if (typeof made.dm_room_mxid !== "string") {
    throw new Error(`${bridge}: no room for ${chat}`);
  }
  return made.dm_room_mxid;
}

/**
 * Sends `text` as him into the bridge's room for `chat`. `txn` makes it once: the homeserver drops a second send with
 * the same transaction id from the same account.
 */
async function sendMatrix(
  bridge: string,
  chat: string,
  text: string,
  txn: string
) {
  const room = encodeURIComponent(await roomOf(bridge, chat));
  const auth = owner().token;
  await call(`${HOMESERVER}/rooms/${room}/join`, auth, { method: "POST" });
  await call(
    `${HOMESERVER}/rooms/${room}/send/m.room.message/${encodeURIComponent(txn)}`,
    auth,
    { body: JSON.stringify({ body: text, msgtype: "m.text" }), method: "PUT" }
  );
}

/** A bridged network's `send` (sources/contract.ts): its messages and its block, both through the one bridge. */
export const bridgeSend = (bridge: string) => ({
  blocked: () => readBlock(bridge),
  deliver: (chat: string, text: string, txn: string) =>
    sendMatrix(bridge, chat, text, txn),
});

/** One step of a bridge's login, as its provisioning API gives it. */
export interface LoginStep {
  complete?: { user_login_id?: string };
  cookies?: { fields?: { id: string; required?: boolean }[]; url?: string };
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

/** What a login asks of him: to look at something (a QR code, a code), and to give a value (a field, a cookie). */
export interface LoginAsk {
  show: (step: LoginStep) => void;
  value: (field: { hidden: boolean; id: string; name: string }) => string;
}

/** The ways a bridge offers to link it (QR, email and password, cookies). */
export const loginFlows = async (bridge: string) =>
  ((await provision(bridge, "login/flows")).flows ?? []) as {
    description: string;
    id: string;
    name: string;
  }[];

/** What a step asks him to give: its fields (a password hidden), or its cookies (each hidden); none for one he looks at. */
function fieldsOf(step: LoginStep) {
  if (step.type === "user_input") {
    return (step.user_input?.fields ?? []).map((f) => ({
      hidden: f.type === "password",
      id: f.id,
      name: f.name ?? f.id,
    }));
  }
  return step.type === "cookies"
    ? (step.cookies?.fields ?? []).map((f) => ({
        hidden: true,
        id: f.id,
        name: f.id,
      }))
    : [];
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
    const fields = fieldsOf(step);
    const body = Object.fromEntries(fields.map((f) => [f.id, ask.value(f)]));
    // biome-ignore lint/performance/noAwaitInLoops: each step follows the last
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
