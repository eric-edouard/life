import { afterAll, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";
import { linesOf } from "../../core/files";
import { LOG_DIR } from "../../core/log";
import {
  setSettings,
  settings,
  connector as settingsOf,
} from "../../core/settings";
import { LEDGER } from "../../memory/memory-files";
import { placesOf } from "../../memory/places";
import { readToldLife, TOLD_LIFE } from "../../memory/told-life";
import { apply, forward, type Stay } from "../../sources/lifelog";
import {
  conversation,
  lifelogServer,
  lifelogStore,
  pageFixture,
  turnFixture,
} from "../../sources/store-fixtures";
import { ask } from "../asks";
import { ownerTokens } from "./auth";
import { buildServer, correct, createMcp } from "./mcp";

const { metadata, origin, resource: RESOURCE } = settingsOf();
const ISSUER = `${origin}/auth`;

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
const connector = createMcp(verify, ISSUER);

const SECONDS = Math.floor(NOW.getTime() / 1000);

/** A token as the issuer would sign it, unless `over` says otherwise; `lifetime` in seconds from NOW. */
function token(over: Record<string, unknown> = {}, lifetime = 3600) {
  return new SignJWT({
    agent: "Orbit",
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

test("a token signed with a key the issuer lacks is the token's fault", async () => {
  const bearer = await new SignJWT({ aud: RESOURCE, iss: ISSUER })
    .setProtectedHeader({ alg: "EdDSA", kid: "k2" })
    .setExpirationTime(SECONDS + 60)
    .sign(privateKey);
  expect(((await verify(bearer)) as { refusal?: string }).refusal).toBe(
    "invalid"
  );
});

test("tools/list: the read-only tools; `correct_memory` asks for approval, `change_todo_item` and `tell_life` write but are not destructive", async () => {
  const { json } = await rpc(await token(), "tools/list");
  const tools: {
    annotations: Record<string, boolean>;
    name: string;
  }[] = json.result.tools;
  expect(tools.map((t) => t.name).sort()).toEqual([
    "change_todo_item",
    "correct_memory",
    "fetch",
    "read_agent_asks",
    "read_area_page",
    "read_chats",
    "read_day",
    "read_fact_checks",
    "read_life_status",
    "read_matter",
    "read_matters",
    "read_memory_changes",
    "read_new_events",
    "read_observation",
    "read_open_todo_items",
    "read_person_page",
    "read_places_visited",
    "read_processing_runs",
    "search",
    "tell_life",
  ]);
  // The arguments' names are pinned too: a part of a read goes through `fetch`'s `id`, never a new argument.
  expect(
    json.result.tools
      .map(
        (t: { inputSchema: { properties?: object }; name: string }) =>
          `${t.name}(${Object.keys(t.inputSchema.properties ?? {})
            .sort()
            .join(",")})`
      )
      .sort()
  ).toEqual([
    "change_todo_item(due,kind,list,notes,obs,priority,prompt,recurrence,said,section,subtasks,target,title,urgent)",
    "correct_memory(aliases,answer,correction,id,jobId,kind,label,name,newName,note,personId,ref,title,to,turnIndex)",
    "fetch(fromTurn,id,limit)",
    "read_agent_asks(cursor,limit)",
    "read_area_page(name)",
    "read_chats(before,chat,from,to,who)",
    "read_day(date)",
    "read_fact_checks()",
    "read_life_status()",
    "read_matter(id)",
    "read_matters(area,person,project)",
    "read_memory_changes(about,cursor,limit,run,since,types)",
    "read_new_events(arguments,cursor,event,limit)",
    "read_observation(id)",
    "read_open_todo_items(list)",
    "read_person_page(before,name)",
    "read_places_visited(at,from,latitude,longitude,place,radiusM,to)",
    "read_processing_runs(cursor,limit,steps)",
    "search(from,query,to)",
    "tell_life(asked,said)",
  ]);
  // Clients see each tool's real schema, though `tool()` validates the arguments itself.
  const claim = json.result.tools.find(
    (t: { name: string }) => t.name === "read_observation"
  );
  expect(claim.inputSchema).toMatchObject({
    properties: { id: { type: "string" } },
    required: ["id"],
  });
  // An item's id: Google Tasks' strings, or Reminders' numbers as the tool first took them.
  const reminders = json.result.tools.find(
    (t: { name: string }) => t.name === "change_todo_item"
  );
  expect(reminders.inputSchema.properties.target).toMatchObject({
    anyOf: [{ type: "string" }, { type: "integer" }],
  });
  const writes = ["correct_memory", "change_todo_item", "tell_life"];
  for (const reads of tools.filter((x) => !writes.includes(x.name))) {
    expect(reads.annotations).toMatchObject({
      openWorldHint: false,
      readOnlyHint: true,
    });
  }
  for (const name of writes) {
    expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
      destructiveHint: name === "correct_memory",
      openWorldHint: false,
      readOnlyHint: false,
    });
  }
});

test("the status reads: refused without the owner's token, JSON with it", async () => {
  const call = (bearer: string | null, name: string, args: object = {}) =>
    rpc(bearer, "tools/call", { arguments: args, name });
  expect((await call(null, "read_life_status")).res.status).toBe(401);
  expect(
    (await call(await token({ sub: "someone" }), "read_memory_changes")).res
      .status
  ).toBe(403);
  const { json } = await call(await token(), "read_life_status");
  expect(json.result).toMatchObject({ isError: false });
  expect(json.result.structuredContent).toBeUndefined();
  expect(JSON.parse(json.result.content[0].text).observedAt).toBeString();
  const bad = await call(await token(), "read_memory_changes", {
    cursor: "nope",
  });
  expect(bad.json.result).toMatchObject({ isError: true });
});

test("Events: `events/poll` and `read_new_events` are one poll; an unknown event is refused", async () => {
  const bearer = await token();
  const poll = (await rpc(bearer, "events/poll", { name: "message.received" }))
    .json.result;
  expect(poll).toMatchObject({ events: [], hasMore: false });
  const tool = await rpc(bearer, "tools/call", {
    arguments: { cursor: poll.cursor, event: "message.received" },
    name: "read_new_events",
  });
  expect(JSON.parse(tool.json.result.content[0].text)).toMatchObject({
    cursor: poll.cursor,
    events: [],
  });
  const unknown = await rpc(bearer, "tools/call", {
    arguments: { event: "ask.received" },
    name: "read_new_events",
  });
  expect(unknown.json.result).toMatchObject({ isError: true });
});

test("a call logs who asked, the arguments, and what surfaced without its text", async () => {
  const logged = async (asked: string) => {
    await rpc(await token(), "tools/call", {
      arguments: { id: asked },
      name: "read_observation",
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
    agent: "Orbit",
    args: { id },
    chars: `no observation ${id}`.length,
    client: "chatgpt-client",
    error: true,
    ids: [id],
    kind: "mcp.call",
    tool: "read_observation",
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
  const asker = { error: true };
  expect(
    await last(bearer, "tools/call", {
      arguments: { id: 5 },
      name: "read_observation",
    })
  ).toMatchObject({
    ...asker,
    agent: "Orbit",
    client: "chatgpt-client",
    tool: "read_observation",
  });
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
  await modern("tools/call", { arguments: {}, name: "read_observation" });
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

test("read_agent_asks: the paired agent's asks only, in the order recorded, each once past its cursor", async () => {
  const said = (quote: string, agent: string, at: string) =>
    ask(
      { at, quote, ref: `test:${quote}` },
      { agent, confidence: "high" },
      "session",
      "test"
    );
  const call = async (as: string, cursor?: string) =>
    JSON.parse(
      (
        await rpc(as, "tools/call", {
          arguments: cursor ? { cursor } : {},
          name: "read_agent_asks",
        })
      ).json.result.content[0].text
    );
  const bearer = await token();
  try {
    said("call the bank", "Orbit", "2026-10-15T09:00:00.000Z");
    said("water the plants", "Comet", "2026-10-15T09:01:00.000Z");
    said("call the bank", "Orbit", "2026-10-15T09:00:00.000Z");
    const first = await call(bearer);
    expect(first.asks.map((a: { quote: string }) => a.quote)).toEqual([
      "call the bank",
    ]);
    expect(first.asks[0]).toMatchObject({
      confidence: "high",
      spoke: "2026-10-15T09:00:00.000Z",
    });
    expect((await call(bearer, first.cursor)).asks).toEqual([]);
    said("book the dentist", "Orbit", "2026-10-15T09:02:00.000Z");
    const next = await call(bearer, first.cursor);
    expect(next.asks.map((a: { quote: string }) => a.quote)).toEqual([
      "book the dentist",
    ]);
    // An app paired without an agent reads the rest, but has no asks.
    const bare = await token({ agent: undefined });
    expect(
      (
        await rpc(bare, "tools/call", {
          arguments: {},
          name: "read_agent_asks",
        })
      ).json.result.content[0].text
    ).toContain("paired without an agent");
  } finally {
    rmSync(LEDGER, { force: true });
  }
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
      rpc(bearer, "tools/call", {
        arguments: arguments_,
        name: "change_todo_item",
      })
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

test("the server is named Life, carries its icons, and its instructions fit in 512 characters", async () => {
  const { json } = await rpc(await token(), "initialize", {
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
    protocolVersion: "2025-06-18",
  });
  expect(json.result.serverInfo).toMatchObject({ name: "Life", title: "Life" });
  const { instructions } = json.result;
  expect(instructions).toStartWith("Life is the owner's memory");
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
  // A date is his day where he was then, not where the phone is now: 6 Oct began in Jakarta and ended in Berlin.
  const asked: unknown[] = [];
  await placesOf(
    { at: "2026-10-06" },
    {
      visits: (q) => {
        asked.push(q);
        return Promise.resolve([]);
      },
      where: () => Promise.reject(new Error("a date is never sent")),
    },
    open
  );
  expect(asked).toEqual([
    {
      from: "2026-10-05T17:00:00.000Z",
      latitude: undefined,
      longitude: undefined,
      place: undefined,
      radiusM: undefined,
      to: "2026-10-06T22:00:00.000Z",
    },
  ]);
});

test("with the actions output off, the connector offers no Reminders tool", async () => {
  const on = settings().todoList;
  setSettings({ todoList: null });
  try {
    const { json } = await rpc(await token(), "tools/list");
    const names = json.result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("change_todo_item");
    expect(names).not.toContain("read_open_todo_items");
    expect(names).toContain("read_agent_asks");
  } finally {
    setSettings({ todoList: on });
  }
});

test("read_fact_checks keeps its output keys: factChecks, each with doubts, from, quote, ref, text", async () => {
  const checks = await import("../../memory/checks");
  const check = [{ evidence: null, guess: "g", kind: "ending", ref: "a" }];
  const spy = spyOn(checks, "checksNow").mockResolvedValue(check as never);
  try {
    const { json } = await rpc(await token(), "tools/call", {
      arguments: {},
      name: "read_fact_checks",
    });
    const body = JSON.parse(json.result.content[0].text);
    expect(Object.keys(body)).toEqual(["factChecks"]);
    expect(Object.keys(body.factChecks[0]).sort().join()).toBe(
      "doubts,from,quote,ref,text"
    );
  } finally {
    spy.mockRestore();
  }
});

test("a fact check's answer is his: an agent's token is refused", async () => {
  await expect(
    correct(
      { answer: "true", kind: "fact_check", ref: "obs_000000000001" },
      "orbit"
    )
  ).rejects.toThrow("an agent's words are not his");
});

test("tell_life keeps his words verbatim, marked, the question as the assistant's line; an agent's call is refused", async () => {
  rmSync(TOLD_LIFE, { force: true });
  const tell = async (over: Record<string, unknown>) =>
    (
      await rpc(await token(over), "tools/call", {
        arguments: {
          asked: "Where did you grow up?",
          said: "In Lyon, until 12.",
        },
        name: "tell_life",
      })
    ).json.result;
  expect(await tell({})).toMatchObject({ isError: true });
  expect(await tell({ agent: undefined })).toMatchObject({ isError: false });
  const [asked, said] = readToldLife(new Date(0));
  expect(asked).toMatchObject({
    fromMe: false,
    text: "Where did you grow up?",
  });
  expect(said).toMatchObject({
    fromMe: true,
    marked: true,
    source: "told-life",
    text: "In Lyon, until 12.",
  });
});

test("built to serve reads only (the question cases' agent), the connector registers no tool that writes or acts", async () => {
  const handler = createMcpHandler(() => buildServer(true));
  const res = await handler.fetch(
    new Request(RESOURCE, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      method: "POST",
    })
  );
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data:"));
  const tools: { annotations: Record<string, boolean>; name: string }[] =
    JSON.parse(data ? data.slice(5) : body).result.tools;
  const names = tools.map((t) => t.name);
  expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  for (const writes of ["correct_memory", "change_todo_item", "tell_life"]) {
    expect(names).not.toContain(writes);
  }
  expect(names).toContain("read_person_page");
  expect(names).toContain("search");
});

test("read_matters lists the open matters, of one project when asked; read_matter opens one with its steps", async () => {
  const who = await import("../../memory/who");
  const matters = await import("../../memory/matters");
  const step = (kind: string, text: string, day: string, ref: string) => ({
    at: `${day}T10:00:00.000Z`,
    day,
    ended: false,
    kind,
    quote: `"${text}" said Gran`,
    ref,
    text,
  });
  const view = (over: object) => ({
    areas: [],
    lone: false,
    open: true,
    owedTo: [],
    projects: [],
    told: [],
    waitingOn: [],
    with: [],
    ...over,
  });
  const steps = [
    step("episode", "Gran's watch", "2026-10-02", "ep_000000000001"),
    step("promise", "Call the shop", "2026-10-12", "obs_000000000005"),
  ];
  const errand = view({
    id: "matter_aaaaaaaaaaaa",
    name: "Mend Gran's watch",
    next: steps[1],
    owedTo: ["person:gran"],
    projects: ["shop-fit-out"],
    status: "moving",
    steps,
    with: ["person:partner"],
  });
  const other = view({
    id: "matter_bbbbbbbbbbbb",
    name: "Renew the lease",
    next: step(
      "waiting_on_someone",
      "Landlord's reply",
      "2026-10-01",
      "obs_000000000009"
    ),
    status: "waiting_on_someone",
    steps: [],
    waitingOn: ["person:shop"],
  });
  const people = spyOn(who, "readPeople").mockResolvedValue({
    nameOf: (r: string) => r.replace("person:", ""),
    truth: {
      areas: [],
      projects: [{ id: "shop-fit-out", name: "Shop fit-out" }],
    },
  } as never);
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    errand,
    other,
    {
      ...view({ id: "matter_cccccccccccc", name: "Old", steps: [] }),
      open: false,
      status: "done",
    },
  ] as never);
  try {
    const call = async (name: string, args: object) =>
      (await rpc(await token(), "tools/call", { arguments: args, name })).json
        .result.content[0].text as string;
    const all = await call("read_matters", {});
    expect(all).toContain(
      "- matter_aaaaaaaaaaaa Mend Gran's watch [moving]; owed to gran; next: Call the shop (2026-10-12)"
    );
    expect(all).toContain("waiting on shop");
    expect(all).not.toContain("Old");
    const ofProject = await call("read_matters", { project: "Shop fit-out" });
    expect(ofProject).toContain("matter_aaaaaaaaaaaa");
    expect(ofProject).not.toContain("matter_bbbbbbbbbbbb");
    const one = (
      await call("read_matter", { id: "matter_aaaaaaaaaaaa" })
    ).split("\n");
    expect(one.slice(0, 4)).toEqual([
      "matter_aaaaaaaaaaaa Mend Gran's watch [moving]",
      "owed to: gran",
      "with: partner",
      "Projects: shop-fit-out",
    ]);
    expect(one).toContain(
      '- 2026-10-12 promise obs_000000000005: Call the shop ""Call the shop" said Gran"'
    );
    expect(await call("read_matter", { id: "matter_zzzzzzzzzzzz" })).toBe(
      "No matter matter_zzzzzzzzzzzz."
    );
  } finally {
    people.mockRestore();
    book.mockRestore();
  }
});
