import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { ISSUER, ownerTokens, RESOURCE } from "./auth";
import { LOG_DIR } from "./log";
import { correct, createMcp } from "./mcp";
import { linesOf } from "./memory/ledger";
import { placesOf } from "./memory/places";
import {
  chapter,
  conversation,
  lifelogServer,
  lifelogStore,
  page,
  turn,
} from "./sources/fixtures";
import { apply, forward, type Stay } from "./sources/lifelog";

const OWNER = "owner-sub";
const CHALLENGE =
  'Bearer resource_metadata="https://life.ericedouard.com/.well-known/oauth-protected-resource/mcp", scope="life:read offline_access"';
const NOW = new Date("2026-10-15T10:00:00Z");

const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
  extractable: true,
});
const jwk: JWK = { ...(await exportJWK(publicKey)), alg: "EdDSA", kid: "k1" };
const jwks = createLocalJWKSet({ keys: [jwk] });
const verify = ownerTokens({
  jwks,
  now: () => NOW.getTime(),
  ownerSub: OWNER,
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
  const res = await connector.handle(
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
    const res = await connector.handle(
      new Request(`https://life.ericedouard.com${path}`)
    );
    expect(await res?.json()).toEqual({
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      resource: RESOURCE,
      scopes_supported: ["life:read", "offline_access"],
    });
  }
  expect(
    await connector.handle(new Request("https://life.ericedouard.com/v1/ask"))
  ).toBeNull();
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
  expect((await rpc(await token(), "tools/list")).res.status).toBe(200);
});

test("tools/list: twelve read-only tools; `correct` asks for approval, `reminders` writes but undoes, so Atlas runs unattended", async () => {
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
    "runs",
    "search",
    "status",
  ]);
  const writes = ["correct", "reminders"];
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
  expect(json.result.isError).toBe(false);
  expect(json.result.structuredContent.observedAt).toBe(
    JSON.parse(json.result.content[0].text).observedAt
  );
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

test("reminders takes no instinct kind and needs his words: refused before anything acts", async () => {
  const bearer = await token();
  const calls = await Promise.all(
    [
      { kind: "instinct", said: "send it to Instinct", title: "x" },
      { kind: "add", said: "", title: "x" },
    ].map((arguments_) =>
      rpc(bearer, "tools/call", { arguments: arguments_, name: "reminders" })
    )
  );
  for (const { json } of calls) {
    expect(json.result.isError).toBe(true);
  }
});

/** A call as a 2026-07-28 client makes it: the version header and the per-request envelope. */
const modern = async (method: string, params: object = {}) =>
  rpc(
    await token(),
    method,
    {
      ...params,
      _meta: {
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "chatgpt", version: "1" },
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      },
    },
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
    "playbook",
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

test("the server is named Life and carries its icons", async () => {
  const { json } = await rpc(await token(), "initialize", {
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
    protocolVersion: "2025-06-18",
  });
  expect(json.result.serverInfo).toMatchObject({ name: "Life", title: "Life" });
  expect(
    json.result.serverInfo.icons.map((i: { src: string }) => i.src)
  ).toEqual([
    "https://life.ericedouard.com/icon.svg",
    "https://life.ericedouard.com/icon-512.png",
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
      page({
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
        turns: [turn(0, "2026-10-14T10:00:00.000Z", null, null)],
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
