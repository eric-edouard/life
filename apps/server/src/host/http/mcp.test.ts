import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { HOUR, MIN } from "../../core/clock";
import { linesOf } from "../../core/files";
import { LOG_DIR } from "../../core/log";
import { LIFE_CODE_DIR, OWNER_DATA_DIR } from "../../core/paths";
import {
  setSettings,
  settings,
  connector as settingsOf,
} from "../../core/settings";
import { ACTIONS } from "../../memory/ledger";
import { placesOf } from "../../memory/places";
import { apply, forward, type Stay } from "../../sources/lifelog";
import {
  chapter,
  conversation,
  lifelogServer,
  lifelogStore,
  pageFixture,
  turnFixture,
} from "../../sources/store-fixtures";
import { protocol, sealed, update } from "../agent";
import { ownerTokens } from "./auth";
import { correct, createMcp } from "./mcp";

const { issuer: ISSUER, metadata, resource: RESOURCE } = settingsOf();

const OWNER = "owner-sub";
const CHALLENGE = `Bearer resource_metadata="${metadata}", scope="life:read offline_access"`;
const NOW = new Date("2026-10-15T10:00:00Z");

const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
  extractable: true,
});
const jwk: JWK = { ...(await exportJWK(publicKey)), alg: "EdDSA", kid: "k1" };
const jwks = createLocalJWKSet({ keys: [jwk] });
const verify = ownerTokens({
  issuer: ISSUER,
  jwks,
  now: () => NOW.getTime(),
  ownerSub: OWNER,
  resource: RESOURCE,
});
const connector = createMcp(verify);

const SECONDS = Math.floor(NOW.getTime() / 1000);

/** A token as lifelog would issue it, unless `over` says otherwise; `lifetime` in seconds from NOW. */
function token(over: Record<string, unknown> = {}, lifetime = 3600) {
  return new SignJWT({
    aud: RESOURCE,
    client_id: "chatgpt-client",
    iss: ISSUER,
    scope: "life:read offline_access",
    sub: OWNER,
    ...over,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setIssuedAt(SECONDS)
    .setExpirationTime(SECONDS + lifetime)
    .sign(privateKey);
}

/** One JSON-RPC call to /mcp (the answer may come as JSON or as one server-sent event). */
async function rpc(
  bearer: string | null,
  method: string,
  params: object = {},
  headers: Record<string, string> = {}
) {
  const res = await connector.request(
    new Request(RESOURCE, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      headers: {
        accept: "application/json, text/event-stream",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        "content-type": "application/json",
        "user-agent": "openai-mcp/1.0.0 (test)",
        ...headers,
      },
      method: "POST",
    })
  );
  const body = res ? await res.text() : "";
  const data = body.split("\n").find((l) => l.startsWith("data:"));
  return {
    json: res?.ok ? JSON.parse(data ? data.slice(5) : body) : null,
    res: res as Response,
  };
}

test("no token: 401 with the challenge that names the metadata", async () => {
  const { res } = await rpc(null, "tools/list");
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
});

test("protected-resource metadata on both paths; other paths are not the connector's", async () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: two requests
    const res = await connector.request(
      new Request(`https://life.example.test${path}`)
    );
    expect(await res?.json()).toEqual({
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      resource: RESOURCE,
      scopes_supported: ["life:read", "offline_access"],
    });
  }
  expect(
    (await connector.request(new Request("https://life.example.test/v1/ask")))
      .status
  ).toBe(404);
});

test("a token for another audience, issuer, owner, scope or time is refused; the right one passes", async () => {
  const refused: [Promise<string> | string, number][] = [
    [token({ aud: "https://elsewhere.example/mcp" }), 401],
    [token({ iss: "https://elsewhere.example" }), 401],
    [token({}, -60), 401],
    [token({ sub: "someone-else" }), 403],
    // Right audience, but no life:read: an offline_access-only token reads nothing.
    [token({ scope: "offline_access" }), 403],
    [token({ scope: "" }), 403],
    ["not.a.jwt", 401],
  ];
  const statuses = await Promise.all(
    refused.map(
      async ([bearer]) => (await rpc(await bearer, "tools/list")).res.status
    )
  );
  expect(statuses).toEqual(refused.map(([, status]) => status));
  const expired = (await rpc(await token({}, -60), "tools/list")).res;
  expect(expired.headers.get("www-authenticate")).toBe(
    `${CHALLENGE}, error="invalid_token"`
  );
  expect((await rpc(await token(), "tools/list")).res.status).toBe(200);
});

test("lifelog's keys out of reach answer 503, not a refused token; a key it lacks is still the token's fault", async () => {
  // 20 Oct: a JWKS fetch timing out was reported as an invalid token.
  const lifelog = Bun.serve({
    fetch: async ({ url }) => {
      const { pathname } = new URL(url);
      if (pathname === "/slow") {
        await Bun.sleep(1000);
      }
      return pathname === "/down"
        ? new Response("", { status: 502 })
        : Response.json({ keys: [jwk] });
    },
    port: 0,
  });
  try {
    const refusal = async (path: string, kid = "k1") => {
      const at = ownerTokens({
        issuer: ISSUER,
        jwks: createRemoteJWKSet(new URL(path, lifelog.url), {
          timeoutDuration: 100,
        }),
        now: () => NOW.getTime(),
        ownerSub: OWNER,
        resource: RESOURCE,
      });
      const bearer = await new SignJWT({ aud: RESOURCE, iss: ISSUER })
        .setProtectedHeader({ alg: "EdDSA", kid })
        .setExpirationTime(SECONDS + 60)
        .sign(privateKey);
      return (await at(bearer)) as { refusal?: string };
    };
    expect((await refusal("/slow")).refusal).toBe("unreachable");
    expect((await refusal("/down")).refusal).toBe("unreachable");
    expect((await refusal("/keys", "k2")).refusal).toBe("invalid");
    expect((await refusal("/keys")).refusal).toBe("forbidden");
    const down = createMcp(async () => ({ refusal: "unreachable", why: "x" }));
    const res = await down.request(
      new Request(RESOURCE, {
        headers: { authorization: "Bearer t" },
        method: "POST",
      })
    );
    expect(res?.status).toBe(503);
  } finally {
    lifelog.stop(true);
  }
});

test("tools/list: thirteen read-only tools; `correct` asks for approval, `reminders`, `task` and `reply` write but are not destructive, so Orbit runs unattended", async () => {
  const { json } = await rpc(await token(), "tools/list");
  const tools: {
    annotations: Record<string, boolean>;
    name: string;
  }[] = json.result.tools;
  expect(tools.map((t) => t.name).sort()).toEqual([
    "area",
    "changes",
    "chats",
    "claim",
    "correct",
    "day",
    "fetch",
    "open_reminders",
    "person",
    "places",
    "reminders",
    "reply",
    "runs",
    "search",
    "status",
    "task",
    "tasks",
  ]);
  // Clients see each tool's real schema, though `tool()` validates the arguments itself.
  const claim = json.result.tools.find(
    (t: { name: string }) => t.name === "claim"
  );
  expect(claim.inputSchema).toMatchObject({
    properties: { id: { type: "string" } },
    required: ["id"],
  });
  // An item's id: Google Tasks' strings, or Reminders' numbers as the tool first took them.
  const reminders = json.result.tools.find(
    (t: { name: string }) => t.name === "reminders"
  );
  expect(reminders.inputSchema.properties.target).toMatchObject({
    anyOf: [{ type: "string" }, { type: "integer" }],
  });
  const writes = ["correct", "reminders", "reply", "task"];
  for (const reads of tools.filter((x) => !writes.includes(x.name))) {
    expect(reads.annotations).toMatchObject({
      openWorldHint: false,
      readOnlyHint: true,
    });
  }
  for (const name of writes) {
    expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
      destructiveHint: name === "correct",
      openWorldHint: false,
      readOnlyHint: false,
    });
  }
});

test("the dashboard reads: refused without the owner's token, JSON with it", async () => {
  const call = (bearer: string | null, name: string, args: object = {}) =>
    rpc(bearer, "tools/call", { arguments: args, name });
  expect((await call(null, "status")).res.status).toBe(401);
  expect(
    (await call(await token({ sub: "someone" }), "changes")).res.status
  ).toBe(403);
  const { json } = await call(await token(), "status");
  expect(json.result).toMatchObject({ isError: false });
  expect(json.result.structuredContent).toBeUndefined();
  expect(JSON.parse(json.result.content[0].text).observedAt).toBeString();
  const bad = await call(await token(), "changes", { cursor: "nope" });
  expect(bad.json.result).toMatchObject({ isError: true });
});

test("a call logs who asked, the arguments, and what surfaced without its text", async () => {
  const logged = async (asked: string) => {
    await rpc(await token(), "tools/call", {
      arguments: { id: asked },
      name: "claim",
    });
    return linesOf(
      join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    )
      .map((l) => JSON.parse(l))
      .findLast((l) => l.kind === "mcp.call");
  };
  expect((await logged("x".repeat(300))).args.id).toBe(`${"x".repeat(199)}…`);
  const id = "obs_0123456789ab";
  expect(await logged(id)).toMatchObject({
    agent: "openai-mcp/1.0.0",
    args: { id },
    chars: `no observation ${id}`.length,
    client: "chatgpt-client",
    error: true,
    ids: [id],
    kind: "mcp.call",
    tool: "claim",
  });
});

const logged = () =>
  linesOf(join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`))
    .map((l) => JSON.parse(l))
    .filter((l) => l.kind === "mcp.call");

test("a refused token, invalid arguments and the SDK's own rejections are logged; a request with no token is not", async () => {
  const last = async (auth: string | null, method: string, params = {}) => {
    await rpc(auth, method, params);
    return logged().at(-1);
  };
  const bearer = await token();
  const asker = { agent: "openai-mcp/1.0.0", error: true };
  expect(
    await last(bearer, "tools/call", { arguments: { id: 5 }, name: "claim" })
  ).toMatchObject({ ...asker, client: "chatgpt-client", tool: "claim" });
  expect(
    await last(await token({ sub: "someone-else" }), "tools/list")
  ).toMatchObject({ ...asker, refused: "forbidden: not the owner" });
  expect((await last(await token({}, -60), "tools/list")).refused).toContain(
    "exp"
  );
  const before = logged().length;
  await rpc(null, "tools/list");
  expect(logged()).toHaveLength(before);
  // A 2026-07-28 call missing its Mcp-Name header is refused by the SDK before any tool.
  await modern("tools/call", { arguments: {}, name: "claim" });
  expect(logged().at(-1)?.refused).toContain("name-header-missing");
});

test("a streamed request (subscriptions/listen) answers at once: nothing waits on its stream", async () => {
  const method = "subscriptions/listen";
  const res = await connector.request(
    new Request(RESOURCE, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method,
        params: { _meta: META, notifications: {} },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${await token()}`,
        "content-type": "application/json",
        "mcp-method": method,
        "mcp-protocol-version": "2026-07-28",
      },
      method: "POST",
    })
  );
  expect(res?.headers.get("content-type")).toContain("text/event-stream");
  await res?.body?.cancel();
});

test("tasks hands out the playbook, docs/agent.md as his agent's, with its seal, all of truth/me.md and closed tasks cut short; task refuses another seal with both", async () => {
  const bearer = await token();
  const now = new Date().toISOString();
  const words = { at: now, claim: true, seal: sealed().seal };
  let json: Awaited<ReturnType<typeof rpc>>["json"];
  try {
    update({
      ...words,
      deadline: new Date(Date.now() + HOUR).toISOString(),
      note: "on it",
      said: "call the bank",
      state: "working",
    });
    update({
      ...words,
      at: new Date(Date.now() - MIN).toISOString(),
      outcome: "booked ".repeat(100),
      said: "book the dentist",
      state: "done",
    });
    ({ json } = await rpc(bearer, "tools/call", {
      arguments: {},
      name: "tasks",
    }));
  } finally {
    rmSync(ACTIONS, { force: true });
  }
  const { me, playbook, seal, tasks } = JSON.parse(json.result.content[0].text);
  expect(playbook).toBe(
    protocol(readFileSync(join(LIFE_CODE_DIR, "docs", "agent.md"), "utf8"))
  );
  expect(me).toBe(readFileSync(join(OWNER_DATA_DIR, "truth", "me.md"), "utf8"));
  expect(me).toContain("1. Be well.");
  // An open row stays whole; a closed one is cut to four fields.
  expect([tasks[0].quote, tasks[0].steps]).toEqual(["call the bank", []]);
  expect(Object.keys(tasks[1]).sort()).toEqual([
    "id",
    "note",
    "state",
    "title",
  ]);
  expect(tasks[1].note.length).toBeLessThanOrEqual(200);
  expect(tasks[1].title).toBe("book the dentist");
  const refused = await rpc(bearer, "tools/call", {
    arguments: { seal: "stale", state: "dropped", task: "act_000000000000" },
    name: "task",
  });
  const [answer] = refused.json.result.content;
  expect(answer.text).toContain(seal);
  expect(answer.text).toContain(playbook);
});

test("reminders takes no instinct kind and needs his words: refused before anything acts", async () => {
  const bearer = await token();
  const calls = await Promise.all(
    [
      { kind: "instinct", said: "send it to Instinct", title: "x" },
      { kind: "add", said: "", title: "x" },
      { kind: "add", title: "x" },
      { kind: "remove", obs: "obs_000000000001", target: 1, title: "x" },
      {
        kind: "add",
        list: "L",
        obs: "obs_000000000001",
        said: "add it",
        title: "x",
      },
      {
        kind: "add",
        list: "L",
        obs: "obs_000000000001",
        prompt: "p",
        title: "x",
      },
    ].map((arguments_) =>
      rpc(bearer, "tools/call", { arguments: arguments_, name: "reminders" })
    )
  );
  for (const { json } of calls) {
    expect(json.result.isError).toBe(true);
  }
});

const META = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "chatgpt", version: "1" },
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
};
/** A call as a 2026-07-28 client makes it: the version header and the per-request envelope. */
const modern = async (method: string, params: object = {}) =>
  rpc(
    await token(),
    method,
    { ...params, _meta: META },
    { "mcp-method": method, "mcp-protocol-version": "2026-07-28" }
  );

test("server/discover offers events and events/list one event, ask; a subscribe to any host but OpenAI's is refused before a request", async () => {
  const discover = await modern("server/discover");
  expect(discover.json.result.supportedVersions).toContain("2026-07-28");
  expect(discover.json.result.capabilities.events).toEqual({});
  const list = await modern("events/list");
  expect(list.json.result.events.map((e: { name: string }) => e.name)).toEqual([
    "ask",
  ]);
  expect(list.json.result.events[0].payloadSchema.required).toEqual([
    "at",
    "confidence",
    "id",
    "quote",
    "ref",
  ]);
  const refused = await modern("events/subscribe", {
    arguments: {},
    cursor: null,
    delivery: {
      mode: "webhook",
      secret: `whsec_${Buffer.alloc(32).toString("base64")}`,
      url: "https://receiver.example.com/cb",
    },
    name: "ask",
  });
  expect(refused.json.error.code).toBe(-32_602);
  const { res } = await rpc(null, "events/list");
  expect(res.status).toBe(401);
});

test("the server is named Life, carries its icons, and its instructions open with the pointer to Orbit's playbook, not a copy, in 512 characters at most", async () => {
  const { json } = await rpc(await token(), "initialize", {
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
    protocolVersion: "2025-06-18",
  });
  expect(json.result.serverInfo).toMatchObject({ name: "Life", title: "Life" });
  const { instructions } = json.result;
  expect(instructions).toStartWith(
    "Orbit: call `tasks` first; its `playbook` field is your instructions."
  );
  expect(instructions).not.toContain("# Orbit: the playbook");
  expect(instructions.length).toBeLessThanOrEqual(512);
  expect(
    json.result.serverInfo.icons.map((i: { src: string }) => i.src)
  ).toEqual([
    "https://life.example.test/icon.svg",
    "https://life.example.test/icon-512.png",
  ]);
});

const server = lifelogServer({
  "/conversations/c1/title": () => ({ id: "c1" }),
  "/people/p1": () => ({ id: "p1" }),
  "/people/p1/merge": () => ({ id: "p1" }),
});
afterAll(() => server.close());

test("forward sends the four corrections and nothing else", async () => {
  await expect(
    forward("rename_person", { id: "p1", name: "Ana" })
  ).resolves.toEqual({
    id: "p1",
  });
  await expect(forward("title", { id: "c1", title: null })).resolves.toEqual({
    id: "c1",
  });
  await expect(forward("delete_person", { id: "p1" })).rejects.toThrow(
    "not a forwardable correction"
  );
});

test("correct names what is missing and sends a merge as lifelog takes it", async () => {
  await expect(correct({ kind: "title" })).rejects.toThrow(
    "title needs: id, title"
  );
  await expect(
    correct({ jobId: "j1", kind: "speaker", label: "speaker_0" })
  ).rejects.toThrow("speaker needs: to or newName");
  server.seen.length = 0;
  expect(
    await correct({ id: "p1", kind: "merge_people", personId: "p2" })
  ).toBe("Done: merge_people.");
  expect(server.seen.at(-1)).toMatchObject({
    body: { personId: "p2" },
    path: "/people/p1/merge",
  });
});

test("places: each stay lists the conversations recorded during it", async () => {
  const open = () => {
    const store = lifelogStore();
    apply(
      store,
      pageFixture({
        chapters: [
          chapter("a", "2026-10-14T10:00:00.000Z", "2026-10-14T10:10:00.000Z"),
        ],
        conversations: [
          conversation("c1"),
          conversation("c2", {
            endAt: "2026-10-12T09:10:00.000Z",
            startAt: "2026-10-12T09:00:00.000Z",
            title: "Elsewhere",
          }),
        ],
        turns: [turnFixture(0, "2026-10-14T10:00:00.000Z", null, null)],
      })
    );
    return store;
  };
  const stays: Stay[] = [
    {
      arrivedAt: "2026-10-14T09:50:00.000Z",
      latitude: 13.7563,
      leftAt: "2026-10-14T10:30:00.000Z",
      longitude: 100.5018,
      place: "Chatuchak Cafe",
    },
    {
      arrivedAt: "2026-10-13T12:00:00.000Z",
      latitude: 13.7,
      leftAt: "2026-10-13T13:00:00.000Z",
      longitude: 100.5,
    },
  ];
  const read = {
    visits: () => Promise.resolve(stays),
    where: () => Promise.resolve([]),
  };
  const answer = await placesOf({ place: "cafe" }, read, open);
  expect(answer).toContain("Stays (2");
  expect(answer).toContain("Chatuchak Cafe (13.7563, 100.5018)");
  expect(answer).toContain("c1");
  expect(answer).toContain("The plumber");
  // The 13 Oct stay has no conversation, and the 12 Oct one is outside both stays.
  expect(answer).not.toContain("Elsewhere");
  expect(await placesOf({}, read, open)).toBeNull();
});

test("with the actions output off, the connector offers no Reminders tool", async () => {
  const on = settings().actions;
  setSettings({ actions: null });
  try {
    const { json } = await rpc(await token(), "tools/list");
    const names = json.result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("reminders");
    expect(names).not.toContain("open_reminders");
    expect(names).toContain("tasks");
  } finally {
    setSettings({ actions: on });
  }
});
