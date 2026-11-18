import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIDGES,
  blockOf,
  cookieValues,
  hasStates,
  linkBridge,
  matrixSend,
  pastedValues,
  readBlock,
  readHomeserverRooms,
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
function fakeHomeserver(joined = 200) {
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
function bridgeWith(events: string[], bridge = "fake") {
  const bridges = join(BRIDGES, "..", `send-${crypto.randomUUID()}`);
  mkdirSync(join(bridges, bridge), { recursive: true });
  const db = new Database(join(bridges, bridge, `${bridge}.db`));
  db.run("create table message (mxid text not null)");
  for (const e of events) {
    db.run("insert into message (mxid) values (?)", [e]);
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
    token: "made-up",
  };
  try {
    expect(
      await matrixSend("fake", () => (c) => c, undefined, at).send(
        { chat: "!r:life.local", text: "See you at 8" },
        "dec_000000000001"
      )
    ).toBe("$ev1");
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

const send = (at: Parameters<typeof matrixSend>[3], txn: string) =>
  matrixSend("fake", () => (c) => c, undefined, at).send(
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
  const path = matrixSend("provnet", () => () => undefined, handleOf, {
    bridges: bridgeWith(["$ev1"], "provnet"),
    confirmMs: 1000,
    homeserver: homeserver.server.url.origin,
    token: "made-up",
  });
  try {
    expect(path.holds(["kit-chat"])).toEqual([]);
    expect(await path.opens?.("kit-chat")).toBe("Test Kit");
    expect(await path.opens?.("nobody")).toBeUndefined();
    expect(await path.opens?.("a-group")).toBeUndefined();
    expect(
      await path.send({ chat: "kit-chat", text: "hi" }, "dec_000000000005")
    ).toBe("$ev1");
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
