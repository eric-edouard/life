import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MACHINE_DIR } from "../core/platform";
import { SECRETS } from "../core/secret";
import { openReadOnly } from "../core/sqlite";

// The bridges' local Matrix homeserver (docs/use/bridges.md): a send goes from the owner's Matrix account into the
// bridge's room for the chat, and the bridge passes it to the network as him. Nothing here reads messages.

/** Each bridge's folder: its config (the provisioning secret), its database (its rooms). */
const BRIDGES = join(MACHINE_DIR, "bridges");
const HOMESERVER = "http://127.0.0.1:8008/_matrix/client/v3";

/** His account on the homeserver, written when the bridges were set up (docs/use/bridges.md). */
const owner = () =>
  JSON.parse(readFileSync(SECRETS.matrix, "utf8")) as {
    token: string;
    user: string;
  };

/** The bridge's own provisioning secret and address, read from its config: never copied. */
function provisioning(bridge: string) {
  const { appservice, provisioning: p } = Bun.YAML.parse(
    readFileSync(join(BRIDGES, bridge, "config.yaml"), "utf8")
  ) as {
    appservice?: { port?: number };
    provisioning?: { shared_secret?: string };
  };
  if (!(p?.shared_secret && appservice?.port)) {
    throw new Error(`${bridge}: no provisioning secret or port in its config`);
  }
  return { port: appservice.port, secret: p.shared_secret };
}

async function call(url: string, auth: string, init: RequestInit = {}) {
  const res = await fetch(url, {
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

/** The bridge's room for a chat: the one it has, else a direct chat it opens with that person (idempotent). */
async function roomOf(bridge: string, chat: string) {
  const known = knownRoom(bridge, chat);
  if (known) {
    return known;
  }
  const { port, secret } = provisioning(bridge);
  const made = await call(
    `http://127.0.0.1:${port}/_matrix/provision/v3/create_dm/${encodeURIComponent(chat)}?user_id=${encodeURIComponent(owner().user)}`,
    secret,
    { method: "POST" }
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
export async function sendMatrix(
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
