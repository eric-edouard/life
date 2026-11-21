import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takesWordsOf } from "./chat-takes";
import {
  BRIDGES,
  blockOf,
  cookieValues,
  ghostOf,
  hasStates,
  linkBridge,
  matrixSend,
  pastedValues,
  readBlock,
  readHomeserverRooms,
  roomFeaturesOf,
  roomPeopleOf,
} from "./matrix";

test("a bridge that isn't set up or running is a reason it is blocked, never a throw", async () => {
  expect(await readBlock("nowhere")).toContain("nowhere bridge not answering");
});

test("a bridge is blocked only when never linked or in a state it won't leave by itself", () => {
  expect(blockOf("whatsapp", [])).toContain("not linked");
  expect(
    blockOf("whatsapp", [{ state: { state_event: "CONNECTED" } }])
  ).toBeUndefined();
  expect(
    blockOf("whatsapp", [{ state: { state_event: "TRANSIENT_DISCONNECT" } }])
  ).toBeUndefined();
  expect(
    blockOf("whatsapp", [
      {
        state: {
          message: "logged out on the phone",
          state_event: "BAD_CREDENTIALS",
        },
      },
    ])
  ).toBe("whatsapp bridge BAD_CREDENTIALS: logged out on the phone");
});

test("a login goes step by step: his answers to each field, a code shown, until it's linked", async () => {
  const seen: { body: string; path: string }[] = [];
  const steps = [
    {
      login_id: "L",
      step_id: "s1",
      type: "user_input",
      user_input: {
        fields: [
          { id: "email", name: "Email" },
          { id: "password", type: "password" },
        ],
      },
    },
    {
      display_and_wait: { data: "123-456", type: "code" },
      login_id: "L",
      step_id: "s2",
      type: "display_and_wait",
    },
    {
      complete: { user_login_id: "u1" },
      login_id: "L",
      step_id: "s3",
      type: "complete",
    },
  ];
  const server = Bun.serve({
    async fetch(req) {
      seen.push({ body: await req.text(), path: new URL(req.url).pathname });
      return Response.json(steps[seen.length - 1]);
    },
    port: 0,
  });
  const dir = join(BRIDGES, "testnet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.yaml"),
    `appservice:\n  port: ${server.port}\nprovisioning:\n  shared_secret: s3cret\n`
  );
  const shown: string[] = [];
  try {
    const id = await linkBridge("testnet", "password", {
      cookies: () => Promise.resolve(new Map()),
      show: (s) => shown.push(s.display_and_wait?.data ?? s.type),
      value: (f) => (f.hidden ? `secret-${f.id}` : `given-${f.id}`),
    });
    expect(id).toBe("u1");
  } finally {
    server.stop();
  }
  expect(seen.map((s) => s.path)).toEqual([
    "/_matrix/provision/v3/login/start/password",
    "/_matrix/provision/v3/login/step/L/s1/user_input",
    "/_matrix/provision/v3/login/step/L/s2/display_and_wait",
  ]);
  expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({
    email: "given-email",
    password: "secret-password",
  });
  expect(shown).toEqual(["user_input", "123-456"]);
});

test("one pasted request fills every cookie: from its Cookie header, -b, or a header source; JSON works too", () => {
  const fields = [
    {
      id: "li_at",
      required: true,
      sources: [{ name: "li_at", type: "cookie" }],
    },
    {
      id: "JSESSIONID",
      required: true,
      sources: [{ name: "JSESSIONID", type: "cookie" }],
    },
    { id: "csrf", sources: [{ name: "csrf-token", type: "request_header" }] },
    { id: "shbid" },
  ];
  const curl = `curl 'https://www.linkedin.com/feed/' -H 'Cookie: li_at=AQE=x; JSESSIONID="ajax:1"' -H 'csrf-token: ajax:1'`;
  // LinkedIn's bridge wants the whole Cookie header, from a request to it.
  expect(
    cookieValues(
      [{ id: "h", sources: [{ name: "Cookie", type: "request_header" }] }],
      pastedValues(curl)
    ).get("h")
  ).toBe('li_at=AQE=x; JSESSIONID="ajax:1"');
  expect(Object.fromEntries(cookieValues(fields, pastedValues(curl)))).toEqual({
    csrf: "ajax:1",
    JSESSIONID: '"ajax:1"',
    li_at: "AQE=x",
  });
  expect(
    Object.fromEntries(
      cookieValues(fields, pastedValues(`curl x -b 'li_at=a; JSESSIONID=b'`))
    )
  ).toEqual({ JSESSIONID: "b", li_at: "a" });
  expect(
    Object.fromEntries(cookieValues(fields, pastedValues('{"li_at":"a"}')))
  ).toEqual({ li_at: "a" });
});

test("a request copied as cURL over several lines, with $'…' quoting, still gives its cookies and headers", () => {
  const copied = String.raw`curl 'https://www.linkedin.com/voyager/api/me' \
  -H 'accept: application/json' \
  -b $'li_at=AQ\u0021x; JSESSIONID="ajax:1"; it\'s=ok' \
  -H $'x-li-track: {"clientVersion":"1.2"}'`;
  const p = pastedValues(copied);
  expect(p.cookies.get("li_at")).toBe("AQ!x");
  expect(p.cookies.get("it's")).toBe("ok");
  expect(p.headers.get("x-li-track")).toBe('{"clientVersion":"1.2"}');
  expect(p.headers.get("accept")).toBe("application/json");
});

test("a bridge just started has logins with no state yet: not settled until each reports one", () => {
  expect(hasStates([{ state: { state_event: "CONNECTED" } }, {}])).toBe(false);
  expect(hasStates([{ state: { state_event: "" } }])).toBe(false);
  expect(hasStates([{ state: { state_event: "BAD_CREDENTIALS" } }])).toBe(true);
  expect(hasStates([])).toBe(true); // not linked is settled: blockOf says so
});

/** A made-up homeserver: answers a join (or refuses it) and a send, and keeps each request. */
function fakeHomeserver(joined = 200, uploaded = 200) {
  const seen: {
    auth: string | null;
    body: string;
    method: string;
    path: string;
  }[] = [];
  const server = Bun.serve({
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      seen.push({
        auth: req.headers.get("authorization"),
        body: await req.text(),
        method: req.method,
        path,
      });
      if (path.endsWith("/media/v3/upload")) {
        return Response.json(
          uploaded === 200
            ? { content_uri: "mxc://life.local/abc" }
            : { errcode: "M_TOO_LARGE" },
          { status: uploaded }
        );
      }
      if (path.includes("/join/")) {
        return Response.json(
          joined === 200 ? { room_id: "!r" } : { errcode: "M_FORBIDDEN" },
          { status: joined }
        );
      }
      return Response.json({ event_id: "$ev1" });
    },
    port: 0,
  });
  return { seen, server };
}

/** A made-up bridge's database: the events it says it sent. */
function bridgeWith(
  events: string[],
  bridge = "fake",
  reactions: string[] = []
) {
  const bridges = join(BRIDGES, "..", `send-${crypto.randomUUID()}`);
  mkdirSync(join(bridges, bridge), { recursive: true });
  const db = new Database(join(bridges, bridge, `${bridge}.db`));
  db.run("create table message (mxid text not null)");
  db.run("create table reaction (mxid text not null)");
  for (const e of events) {
    db.run("insert into message (mxid) values (?)", [e]);
  }
  for (const e of reactions) {
    db.run("insert into reaction (mxid) values (?)", [e]);
  }
  db.close();
  return bridges;
}

test("a send joins the room, then puts exactly the text once under its transaction, and returns the event the bridge confirmed", async () => {
  const { seen, server } = fakeHomeserver();
  const at = {
    bridges: bridgeWith(["$ev1"]),
    confirmMs: 1000,
    homeserver: server.url.origin,
    synapse: synapseWith({}, [["!r:life.local", "$ev1", 1234]]),
    token: "made-up",
  };
  const handed: number[] = [];
  try {
    expect(
      await matrixSend("fake", { at, roomsOf: () => (c) => c }).send(
        { chat: "!r:life.local", text: "See you at 8" },
        "dec_000000000001",
        () => handed.push(seen.length)
      )
    ).toBe("fake:!r:life.local/1234");
    // Handed once the PUT returned (join and PUT seen), before the bridge's confirmation.
    expect(handed).toEqual([2]);
    expect(
      matrixSend("fake", { at, roomsOf: () => (c) => c }).limitMs({
        chat: "!r:life.local",
        file: { bytes: new Uint8Array(), mime: "text/plain", name: "a.txt" },
      })
    ).toBe(2 * 10_000 + 60_000 + 1000);
  } finally {
    server.stop();
  }
  expect(seen.map((r) => [r.method, r.path])).toEqual([
    ["POST", "/_matrix/client/v3/join/!r%3Alife.local"],
    [
      "PUT",
      "/_matrix/client/v3/rooms/!r%3Alife.local/send/m.room.message/dec_000000000001",
    ],
  ]);
  expect(JSON.parse(seen[1]?.body ?? "")).toEqual({
    body: "See you at 8",
    msgtype: "m.text",
  });
  expect(seen[1]?.auth).toBe("Bearer made-up");
});

const send = (
  at: NonNullable<Parameters<typeof matrixSend>[1]["at"]>,
  txn: string
) =>
  matrixSend("fake", { at, roomsOf: () => (c) => c }).send(
    { chat: "!r:life.local", text: "hi" },
    txn
  );

test("a send says whether anything left: a room it can't join sends nothing, an event the bridge never confirms may have gone", async () => {
  const refused = fakeHomeserver(403);
  const silent = fakeHomeserver();
  const at = { bridges: bridgeWith([]), confirmMs: 500, token: "made-up" };
  try {
    await expect(
      send({ ...at, homeserver: refused.server.url.origin }, "dec_000000000002")
    ).rejects.toThrow("not sent: fake room not joined: 403");
    expect(refused.seen).toHaveLength(1);
    await expect(
      send({ ...at, homeserver: silent.server.url.origin }, "dec_000000000003")
    ).rejects.toThrow("may have gone: the homeserver took it ($ev1)");
    await expect(
      send(
        { ...at, homeserver: silent.server.url.origin, token: undefined },
        "dec_000000000004"
      )
    ).rejects.toThrow("not sent");
  } finally {
    refused.server.stop();
    silent.server.stop();
  }
});

test("the homeserver's rooms are the ones it holds: a room version 12 id has no server part, a Beeper chat key is not one", () => {
  const dir = join(BRIDGES, "..", `hs-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "homeserver.db");
  expect(readHomeserverRooms(file)).toEqual([]);
  const db = new Database(file);
  db.run("create table rooms (room_id text not null)");
  db.run("insert into rooms values ('!AbCdEf123'), ('!OldRoom:life.local')");
  db.close();
  const rooms = readHomeserverRooms(file);
  expect(rooms).toContain("!AbCdEf123");
});

/** A made-up bridge provisioning API: knows one handle (`+15550100`), answers 404 for any other. */
function fakeProvisioning() {
  const seen: string[] = [];
  const server = Bun.serve({
    fetch: (req) => {
      const { pathname } = new URL(req.url);
      seen.push(`${req.method} ${decodeURIComponent(pathname)}`);
      if (!pathname.endsWith("%2B15550100")) {
        return Response.json({ errcode: "M_NOT_FOUND" }, { status: 404 });
      }
      return Response.json(
        pathname.includes("create_dm")
          ? { dm_room_mxid: "!NewDm0001", id: "15550100", name: "Test Kit" }
          : { id: "15550100", name: "Test Kit" },
        { status: pathname.includes("create_dm") ? 201 : 200 }
      );
    },
    port: 0,
  });
  mkdirSync(join(BRIDGES, "provnet"), { recursive: true });
  writeFileSync(
    join(BRIDGES, "provnet", "config.yaml"),
    `appservice:\n  port: ${server.port}\nprovisioning:\n  shared_secret: s3cret\n`
  );
  return { seen, server };
}

test("a chat the bridge holds no room for opens by its handle: the network says whether it exists, a send opens it first", async () => {
  const { seen, server } = fakeProvisioning();
  const homeserver = fakeHomeserver();
  const handles: Record<string, string> = {
    "kit-chat": "+15550100",
    nobody: "+15550101",
  };
  const handleOf = (c: string) => handles[c];
  const path = matrixSend("provnet", {
    at: {
      bridges: bridgeWith(["$ev1"], "provnet"),
      confirmMs: 1000,
      homeserver: homeserver.server.url.origin,
      synapse: synapseWith({}, [["!NewDm0001", "$ev1", 55]]),
      token: "made-up",
    },
    handleOf,
    roomsOf: () => () => undefined,
  });
  try {
    expect(path.holds(["kit-chat"])).toEqual([]);
    expect(await path.opens?.("kit-chat")).toBe("Test Kit");
    expect(await path.opens?.("nobody")).toBeUndefined();
    expect(await path.opens?.("a-group")).toBeUndefined();
    expect(
      await path.send({ chat: "kit-chat", text: "hi" }, "dec_000000000005")
    ).toBe("provnet:kit-chat/55");
    expect(homeserver.seen.map((r) => r.path)).toContain(
      "/_matrix/client/v3/rooms/!NewDm0001/send/m.room.message/dec_000000000005"
    );
    await expect(
      path.send({ chat: "nobody", text: "hi" }, "dec_000000000006")
    ).rejects.toThrow("not sent: provnet chat not opened: 404");
    await expect(
      path.send({ chat: "a-group", text: "hi" }, "dec_000000000007")
    ).rejects.toThrow("not sent: provnet holds no room");
  } finally {
    server.stop();
    homeserver.server.stop();
    rmSync(join(BRIDGES, "provnet"), { force: true, recursive: true });
  }
  expect(seen.filter((r) => r.includes("create_dm"))).toEqual([
    "POST /_matrix/provision/v3/create_dm/+15550100",
    "POST /_matrix/provision/v3/create_dm/+15550101",
  ]);
});

/** A made-up homeserver database holding the `com.beeper.room_features` event of each room given. */
function synapseWith(
  features: Record<string, object>,
  events: [room: string, event: string, stream: number][] = []
) {
  const dir = join(BRIDGES, "..", `hs-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "homeserver.db");
  const db = new Database(file);
  db.run(
    "create table current_state_events (room_id text, type text, event_id text)"
  );
  db.run("create table event_json (event_id text, json text)");
  db.run(
    "create table events (event_id text, room_id text, stream_ordering integer)"
  );
  for (const [room, event, stream] of events) {
    db.run("insert into events values (?, ?, ?)", [event, room, stream]);
  }
  Object.entries(features).forEach(([room, content], i) => {
    db.run(
      "insert into current_state_events values (?, 'com.beeper.room_features', ?)",
      [room, `$f${i}`]
    );
    db.run("insert into event_json values (?, ?)", [
      `$f${i}`,
      JSON.stringify({ content }),
    ]);
  });
  db.close();
  return file;
}

const IMAGE = { caption: 1, max_size: 1000, mime_types: { "image/*": 2 } };
const FULL = {
  allowed_reactions: ["👍", "❤️"],
  file: { "m.file": { mime_types: { "*/*": 1 } }, "m.image": IMAGE },
  formatting: { user_link: 1 },
  reaction: 1,
  reply: 1,
};

test("a room's features are its bridge's own state event; a room with none has none", () => {
  const synapse = synapseWith({ "!a": FULL });
  expect(roomFeaturesOf("!a", synapse)).toEqual(FULL);
  expect(roomFeaturesOf("!b", synapse)).toBeUndefined();
  expect(
    roomFeaturesOf("!a", join(BRIDGES, "no-homeserver.db"))
  ).toBeUndefined();
});

test("a room's people are its joined ghosts, him included; his account, the bot and those who left don't count", () => {
  const synapse = synapseWith({});
  const db = new Database(synapse);
  db.run("alter table current_state_events add column state_key text");
  db.run("alter table current_state_events add column membership text");
  for (const [user, membership] of [
    ["@net_ana:life.local", "join"],
    ["@net_kit:life.local", "join"],
    ["@net_him:life.local", "join"],
    ["@net_bo:life.local", "leave"],
    ["@netbot:life.local", "join"],
    ["@owner:life.local", "join"],
  ]) {
    db.run(
      "insert into current_state_events (room_id, type, event_id, state_key, membership) values ('!g', 'm.room.member', ?, ?, ?)",
      [`$${user}`, user, membership]
    );
  }
  db.close();
  expect(roomPeopleOf("!g", "@net_:life.local", synapse)).toBe(3);
  expect(roomPeopleOf("!none", "@net_:life.local", synapse)).toBe(0);
  expect(
    roomPeopleOf("!g", "@net_:life.local", join(BRIDGES, "no-homeserver.db"))
  ).toBeUndefined();
});

test("a bridge's ghost is its username template over a localpart; the default template is the bridge's name", () => {
  mkdirSync(join(BRIDGES, "ghosted"), { recursive: true });
  writeFileSync(
    join(BRIDGES, "ghosted", "config.yaml"),
    "appservice:\n  username_template: gh_{{.}}\n"
  );
  mkdirSync(join(BRIDGES, "plain"), { recursive: true });
  writeFileSync(
    join(BRIDGES, "plain", "config.yaml"),
    "appservice:\n  port: 1\n"
  );
  expect(ghostOf("ghosted", "u1")).toBe("@gh_u1:life.local");
  expect(ghostOf("plain", "u1")).toBe("@plain_u1:life.local");
  rmSync(join(BRIDGES, "ghosted"), { force: true, recursive: true });
  rmSync(join(BRIDGES, "plain"), { force: true, recursive: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);
const file = (text: string, mime = "image/png", name = "menu.png") => ({
  bytes: bytes(text),
  mime,
  name,
});
const ROOM_ = "!full";
/** A message id as the archive gives it: the room and the homeserver's number for the event. */
const ref = (stream: number) => `fake:${ROOM_}/${stream}`;

/** A made-up path into `!full` (its features as given), `!bare` (a bridge that states none) and `!none` (no event). */
const pathWith = (
  features: Record<string, object>,
  home?: ReturnType<typeof fakeHomeserver>,
  reactions: string[] = []
) =>
  matrixSend("fake", {
    at: {
      bridges: bridgeWith(["$ev1", "$t1"], "fake", reactions),
      confirmMs: 500,
      homeserver: home?.server.url.origin,
      synapse: synapseWith(features, [
        [ROOM_, "$t1", 7],
        [ROOM_, "$ev1", 101],
      ]),
      token: "made-up",
    },
    ghostOf: (sender) =>
      sender === "ana-h" ? "@fake_ana-h:life.local" : undefined,
    roomsOf: () => (c) => c,
  });

test("a room takes what its features say, and text when they say nothing: a refusal names what it can't take", async () => {
  const path = pathWith({
    "!bare": {},
    "!full": FULL,
    "!noreply": { reaction: 1, reply: 0 },
  });
  // What it takes, as read_chats tells the agent drafting, is the same rule.
  expect(path.takes("!full")).toEqual({
    file: true,
    mentions: true,
    reaction: ["👍", "❤️"],
    reply: true,
  });
  expect(takesWordsOf(path.takes("!noreply"))).toBe(
    "a draft into this chat takes text, a reaction (an emoji on `onMessage`); nothing else"
  );
  expect(Object.values(path.takes("!none")).some(Boolean)).toBe(false);
  const refusal = (chat: string, over: object) =>
    path.refusal({ chat, text: "hi", ...over });
  expect(await refusal("!none", {})).toBeUndefined();
  expect(await refusal("!none", { onMessage: ref(7) })).toContain(
    "takes text only"
  );
  expect(await refusal("!none", { file: file("x") })).toContain(
    "takes text only"
  );
  expect(await refusal("!bare", { onMessage: "fake:!bare/$t1" })).toContain(
    "no replies"
  );
  expect(
    await refusal("!noreply", { onMessage: "fake:!noreply/$t1" })
  ).toContain("no replies");
  expect(
    await refusal("!bare", {
      onMessage: "fake:!bare/$t1",
      reaction: "👍",
      text: undefined,
    })
  ).toContain("no reactions");
  expect(
    await refusal("!bare", { mentions: [{ name: "Ana", sender: "ana-h" }] })
  ).toContain("no mentions");
  expect(await refusal(ROOM_, { onMessage: ref(7) })).toBeUndefined();
  expect(
    await refusal(ROOM_, {
      onMessage: ref(7),
      reaction: "👍",
      text: undefined,
    })
  ).toBeUndefined();
  expect(
    await refusal(ROOM_, {
      onMessage: ref(7),
      reaction: "😀",
      text: undefined,
    })
  ).toContain("only these reactions: 👍 ❤️");
  expect(
    await refusal(ROOM_, { mentions: [{ name: "Ana", sender: "ana-h" }] })
  ).toBeUndefined();
});

test("a file needs its kind among the room's, its type, its size under max_size, and a caption level for words with it", async () => {
  const path = pathWith({ "!full": FULL });
  const refusal = (over: object) => path.refusal({ chat: ROOM_, ...over });
  expect(
    await refusal({ file: file("x".repeat(1000)), text: "Menu" })
  ).toBeUndefined();
  expect(await refusal({ file: file("x".repeat(1001)) })).toContain(
    "up to 1000 bytes"
  );
  expect(await refusal({ file: file("x", "video/mp4", "a.mp4") })).toContain(
    "takes no video/mp4 files"
  );
  expect(
    await refusal({ file: file("x", "application/pdf", "a.pdf") })
  ).toBeUndefined();
  expect(
    await refusal({ file: file("x", "application/pdf", "a.pdf"), text: "Menu" })
  ).toContain("send the text as its own card");
});

test("a message or sender the bridge doesn't know is refused: another chat's id, one it never held, a sender with no ghost", async () => {
  const path = pathWith({ "!full": FULL });
  const refusal = (over: object) =>
    path.refusal({ chat: ROOM_, text: "hi", ...over });
  expect(await refusal({ onMessage: "fake:!other/$t1" })).toContain(
    "isn't one this chat's bridge holds"
  );
  expect(await refusal({ onMessage: ref(999) })).toContain(
    "isn't one this chat's bridge holds"
  );
  expect(
    await refusal({ mentions: [{ name: "Cy", sender: "cy-h" }] })
  ).toContain("a sender it can't mention");
});

test("each event goes as its exact body: a reply, a mention (escaped, linked, listed), a file with its caption and without, a reaction", async () => {
  const home = fakeHomeserver();
  const path = pathWith({ "!full": FULL }, home, ["$ev1"]);
  const put = () =>
    JSON.parse(home.seen.findLast((r) => r.method === "PUT")?.body ?? "");
  try {
    expect(
      await path.send(
        { chat: ROOM_, onMessage: ref(7), text: "Yes" },
        "dec_000000000011"
      )
    ).toBe(ref(101));
    expect(put()).toEqual({
      body: "Yes",
      "m.relates_to": { "m.in_reply_to": { event_id: "$t1" } },
      msgtype: "m.text",
    });
    await path.send(
      {
        chat: ROOM_,
        mentions: [{ name: "Ana", sender: "ana-h" }],
        text: "Hi @Ana <3 & co\nBye",
      },
      "dec_000000000012"
    );
    expect(put()).toEqual({
      body: "Hi @Ana <3 & co\nBye",
      format: "org.matrix.custom.html",
      formatted_body:
        'Hi <a href="https://matrix.to/#/@fake_ana-h:life.local">@Ana</a> &lt;3 &amp; co<br>Bye',
      "m.mentions": { user_ids: ["@fake_ana-h:life.local"] },
      msgtype: "m.text",
    });
    await path.send(
      { chat: ROOM_, file: file("lunch menu"), text: "The menu" },
      "dec_000000000013"
    );
    const upload = home.seen.findLast((r) =>
      r.path.endsWith("/media/v3/upload")
    );
    expect([upload?.method, upload?.body, upload?.auth]).toEqual([
      "POST",
      "lunch menu",
      "Bearer made-up",
    ]);
    expect(put()).toEqual({
      body: "The menu",
      filename: "menu.png",
      info: { mimetype: "image/png", size: 10 },
      msgtype: "m.image",
      url: "mxc://life.local/abc",
    });
    await path.send(
      { chat: ROOM_, file: file("lunch menu") },
      "dec_000000000014"
    );
    expect(put().body).toBe("menu.png");
    // A reaction is its own event type, confirmed by the bridge's own reaction record.
    expect(
      await path.send(
        { chat: ROOM_, onMessage: ref(7), reaction: "👍" },
        "dec_000000000015"
      )
    ).toBe("$ev1");
    expect(home.seen.at(-1)?.path).toBe(
      "/_matrix/client/v3/rooms/!full/send/m.reaction/dec_000000000015"
    );
    expect(put()).toEqual({
      "m.relates_to": { event_id: "$t1", key: "👍", rel_type: "m.annotation" },
    });
  } finally {
    home.server.stop();
  }
});

test("a reaction the bridge never recorded may have gone, though a message of that event id exists; a refused upload sent nothing", async () => {
  const home = fakeHomeserver();
  const unconfirmed = pathWith({ "!full": FULL }, home);
  const refused = fakeHomeserver(200, 413);
  const big = pathWith({ "!full": FULL }, refused);
  try {
    await expect(
      unconfirmed.send(
        { chat: ROOM_, onMessage: ref(7), reaction: "👍" },
        "dec_000000000016"
      )
    ).rejects.toThrow("may have gone: the homeserver took it ($ev1)");
    await expect(
      big.send({ chat: ROOM_, file: file("x") }, "dec_000000000017")
    ).rejects.toThrow("not sent: the homeserver refused the file: 413");
    expect(refused.seen.some((r) => r.method === "PUT")).toBe(false);
  } finally {
    home.server.stop();
    refused.server.stop();
  }
});

test("a bridged message's id is its homeserver number: a reply finds the event through the homeserver, and only one the bridge holds", async () => {
  const path = matrixSend("instagram", {
    at: {
      bridges: bridgeWith(["$held"], "instagram"),
      synapse: synapseWith({ "!AbCd": FULL }, [
        ["!AbCd", "$held", 1234],
        ["!AbCd", "$other", 1235],
      ]),
    },
    roomsOf: () => (c) => c,
  });
  const refusal = (onMessage: string) =>
    path.refusal({ chat: "!AbCd", onMessage, text: "hi" });
  expect(await refusal("instagram:!AbCd/1234")).toBeUndefined();
  const refused = await Promise.all(
    [
      "instagram:!AbCd/1235",
      "instagram:!AbCd/9999",
      "instagram:!AbCd/$held",
      "instagram:!Other/1234",
    ].map(refusal)
  );
  for (const r of refused) {
    expect(r).toContain("isn't one this chat's bridge holds");
  }
});
