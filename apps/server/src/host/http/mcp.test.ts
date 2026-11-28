import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { SignJWT } from "jose";
import { DAY } from "../../core/clock";
import { linesOf } from "../../core/files";
import { LOG_DIR } from "../../core/log";
import { CONNECTOR_WRITES } from "../../core/names";
import { OWNER_DATA_DIR } from "../../core/paths";
import { setSettings, settings } from "../../core/settings";
import { DECISIONS } from "../../memory/decision-lines";
import { placesOf } from "../../memory/places";
import { readToldLife, TOLD_LIFE } from "../../memory/told-life";
import {
  conversation,
  pageFixture,
  turnFixture,
  voiceStore,
} from "../../sources/store-fixtures";
import { apply, type Stay } from "../../sources/voice-server";
import { buildServer } from "./mcp";
import {
  mcpConnector as connector,
  ISSUER,
  metadata,
  privateKey,
  RESOURCE,
  rpc,
  SECONDS,
  token,
  verify,
} from "./mcp-test-harness";
import { NOT_HIS } from "./mcp-tool";

const CHALLENGE = `Bearer resource_metadata="${metadata}", scope="life:read offline_access"`;
const HIS_ONLY = [
  "read_integrations",
  "read_resource_samples",
  "read_spending",
];

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

test("tools/list: the read-only tools; `correct_memory`, `answer_check` and `change_registered_agent` ask for approval, `change_directory_entry`, `change_todo_item`, `tell_life` and `ask_main_session` write but are not destructive", async () => {
  const { json } = await rpc(await token(), "tools/list");
  const tools: {
    annotations: Record<string, boolean>;
    name: string;
  }[] = json.result.tools;
  expect(tools.map((t) => t.name).sort()).toEqual([
    "answer_check",
    "ask_main_session",
    "change_appointment",
    "change_directory_entry",
    "change_registered_agent",
    "change_setting",
    "change_todo_item",
    "correct_memory",
    "delete_from_memory",
    "fetch",
    "read_appointments",
    "read_area_page",
    "read_chats",
    "read_day",
    "read_inbox",
    "read_integrations",
    "read_life_status",
    "read_matter",
    "read_matters",
    "read_memory_changes",
    "read_new_events",
    "read_observation",
    "read_open_todo_items",
    "read_people_and_organizations",
    "read_person_pictures",
    "read_places_visited",
    "read_processing_runs",
    "read_registered_agents",
    "read_resource_samples",
    "read_spending",
    "read_thread",
    "request_decision",
    "search",
    "sign_in_to_network",
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
    "answer_check(name,note,options,person,rate,ref,undo,value)",
    "ask_main_session(catalog,react,screen,stop,tap,words)",
    "change_appointment(action,appointment)",
    "change_directory_entry(action,aliases,area,domains,goal,handles,id,kind,language,name,number,people,pictureFrom,projects,relation,repos,said,status,text)",
    "change_registered_agent(action,agent,effort,folder,model,name,project,role,runtime,said,step)",
    "change_setting(aura,monthlyUsd)",
    "change_todo_item(due,kind,list,notes,obs,priority,prompt,recurrence,said,section,subtasks,target,title,urgent)",
    "correct_memory(aliases,correction,id,jobId,kind,label,name,newName,personId,title,to,turnIndex)",
    "delete_from_memory(about,confirm,cuts,refs,said,withSources)",
    "fetch(at,fromTurn,id,limit,until)",
    "read_appointments(appointment,pushId)",
    "read_area_page(name)",
    "read_chats(before,chat,from,to,who)",
    "read_day(date)",
    "read_inbox(after,ifNot,limit,pushId)",
    "read_integrations()",
    "read_life_status()",
    "read_matter(id)",
    "read_matters(area,before,ifNot,noProject,person,project,state)",
    "read_memory_changes(about,cursor,limit,run,since,types)",
    "read_new_events(arguments,cursor,event,limit)",
    "read_observation(id)",
    "read_open_todo_items(list)",
    "read_people_and_organizations(before,name,query)",
    "read_person_pictures(ids)",
    "read_places_visited(at,from,latitude,longitude,place,radiusM,to)",
    "read_processing_runs(cursor,limit,steps)",
    "read_registered_agents()",
    "read_resource_samples()",
    "read_spending(month)",
    "read_thread(before,ifNot)",
    "request_decision(ask,changed,context,deadline,doneSeenBy,draft,drafts,edits,follow,gathered,keep,links,merges,needs,onSilence,options,plan,question,recommended,subject,title,why,withdraw)",
    "search(from,query,to)",
    "sign_in_to_network(answers,loginId,network,stepId,type)",
    "tell_life(asked,said)",
  ]);
  // Clients see each tool's real schema, though `tool()` validates the arguments itself.
  const byName = (n: string) =>
    json.result.tools.find((t: { name: string }) => t.name === n);
  const claim = byName("read_observation");
  expect(claim.inputSchema).toMatchObject({
    properties: { id: { type: "string" } },
    required: ["id"],
  });
  // An item's id: Google Tasks' strings, or Reminders' numbers as the tool first took them.
  const reminders = byName("change_todo_item");
  expect(reminders.inputSchema.properties.target).toMatchObject({
    anyOf: [{ type: "string" }, { type: "integer" }],
  });
  // Every write is in the send guard's list (`CONNECTOR_WRITES`), so a new one can't slip past it.
  for (const reads of tools.filter((x) => !CONNECTOR_WRITES.includes(x.name))) {
    expect(reads.annotations).toMatchObject({
      openWorldHint: false,
      readOnlyHint: true,
    });
  }
  for (const name of CONNECTOR_WRITES) {
    expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
      destructiveHint: [
        "correct_memory",
        "answer_check",
        "change_registered_agent",
        "delete_from_memory",
        "sign_in_to_network",
      ].includes(name),
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

// 21 Nov 2026: the log promised metadata only, yet kept a call's arguments (his words in `tell_life`, a card's draft)
// and a refusal's text (which can quote them).
test("a call logs who asked, its arguments' names, and what surfaced without its text", async () => {
  const logged = async (name: string, args: object) => {
    await rpc(await token(), "tools/call", { arguments: args, name });
    return linesOf(
      join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`)
    )
      .map((l) => JSON.parse(l))
      .findLast((l) => l.kind === "mcp.call");
  };
  const id = "obs_0123456789ab";
  const line = await logged("read_observation", { id });
  expect(line).toMatchObject({
    agent: "Orbit",
    args: ["id"],
    chars: `no observation ${id}`.length,
    client: "chatgpt-client",
    error: true,
    ids: [id],
    kind: "mcp.call",
    refused: "error",
    tool: "read_observation",
  });
  const words = "Tell Mia I'm at Lyon station at 6";
  const told = await logged("tell_life", { asked: "x", said: words });
  expect(told).toMatchObject({ args: ["asked", "said"], refused: "not_done" });
  expect(JSON.stringify(told)).not.toContain("Lyon");
});

test("his token only: an agent's read of read_resource_samples or read_spending is refused", async () => {
  const call = async (over: Record<string, unknown>, name: string) =>
    (await rpc(await token(over), "tools/call", { arguments: {}, name })).json
      .result;
  for (const agent of await Promise.all(
    HIS_ONLY.map((n) => call({ id: "agt_made" }, n))
  )) {
    expect(agent).toMatchObject({ isError: true });
    expect(agent.content[0].text).toContain("paired as an agent");
  }
  expect(
    JSON.parse(
      (await call({ agent: undefined }, "read_resource_samples")).content[0]
        .text
    )
  ).toMatchObject({ hour: [] });
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
  ).toMatchObject({ ...asker, refused: "forbidden" });
  // A refusal is logged by its class, never its reason's words.
  const stale = await last(await token({}, -60), "tools/list");
  expect(stale.refused).toBe("invalid");
  const before = logged().length;
  await rpc(null, "tools/list");
  expect(logged()).toHaveLength(before);
  // A 2026-07-28 call missing its Mcp-Name header is refused by the SDK before any tool.
  await modern("tools/call", { arguments: {}, name: "read_observation" });
  expect(logged().at(-1)?.refused).toBe("rejected");
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

test("places: each stay lists the conversations recorded during it", async () => {
  const open = () => {
    const store = voiceStore();
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
  expect(answer).toContain("c1 Conversation at");
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
    expect(names).toContain("read_inbox");
  } finally {
    setSettings({ todoList: on });
  }
});

test("an agent asks a decision; only he answers it, through answer_check; the agent is told by its own event, another agent is not", async () => {
  rmSync(DECISIONS, { force: true });
  const call = async (name: string, args: object, over = {}) =>
    (await rpc(await token(over), "tools/call", { arguments: args, name })).json
      .result;
  const decision = {
    context: "A made-up reason to ask.",
    deadline: new Date(Date.now() + DAY).toISOString(),
    options: [
      { id: "yes", label: "Send it" },
      { id: "no", label: "Not now" },
    ],
    question: "Send Kit the signed quote?",
    title: "He asked for it by Friday.",
  };
  const asked = await call("request_decision", decision);
  expect(asked.isError).toBe(false);
  const { cursor, id } = JSON.parse(asked.content[0].text);
  const inbox = async () =>
    JSON.parse((await call("read_inbox", {})).content[0].text).checks;
  const [listed] = await inbox();
  expect(listed).toMatchObject({
    asker: "Orbit",
    group: "decision",
    question: decision.question,
    ref: id,
  });
  expect(
    await call("answer_check", { options: ["yes"], ref: id })
  ).toMatchObject({ isError: true });
  expect(
    await call(
      "answer_check",
      { note: "go", options: ["yes"], ref: id },
      { agent: undefined }
    )
  ).toMatchObject({ isError: false });
  expect(logged().at(-1)).toMatchObject({
    steps: [{ step: "plan" }, { step: "recorded" }],
    tool: "answer_check",
  });
  expect(await inbox()).toEqual([]);
  const poll = async (over = {}) =>
    JSON.parse(
      (
        await call(
          "read_new_events",
          { cursor, event: "decision.answered" },
          over
        )
      ).content[0].text
    ).events;
  expect(await poll()).toMatchObject([
    {
      data: { answer: { note: "go", options: ["yes"] }, id },
      name: "decision.answered",
    },
  ]);
  expect(await poll({ agent: "Atlas" })).toEqual([]);
  rmSync(DECISIONS, { force: true });
});

test("his own app asks a decision as the owner, with no cursor, and answers it itself once he said so in its chat", async () => {
  rmSync(DECISIONS, { force: true });
  const call = async (name: string, args: object) =>
    (
      await rpc(await token({ agent: undefined }), "tools/call", {
        arguments: args,
        name,
      })
    ).json.result;
  const asked = await call("request_decision", {
    context: "A made-up reason to ask.",
    deadline: new Date(Date.now() + DAY).toISOString(),
    options: [
      { id: "yes", label: "Send it" },
      { id: "no", label: "Not now" },
    ],
    question: "Send Kit the signed quote?",
    title: "He asked for it by Friday.",
  });
  expect(asked.isError).toBe(false);
  const reply = JSON.parse(asked.content[0].text);
  expect(reply.cursor).toBeUndefined();
  const [listed] = JSON.parse(
    (await call("read_inbox", {})).content[0].text
  ).checks;
  expect(listed).toMatchObject({ asker: "owner", ref: reply.id });
  const withdrawn = await rpc(await token(), "tools/call", {
    arguments: { why: "mine", withdraw: reply.id },
    name: "request_decision",
  });
  expect(withdrawn.json.result).toMatchObject({ isError: true });
  const answered = await call("answer_check", {
    options: ["yes"],
    ref: reply.id,
  });
  expect(answered.isError).toBe(false);
  expect(JSON.parse(answered.content[0].text)).toMatchObject({
    asker: { name: "owner", told: "recorded" },
  });
  rmSync(DECISIONS, { force: true });
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

test("ask_main_session refuses an agent's token before anything reaches the desk", async () => {
  const { json } = await rpc(await token({}), "tools/call", {
    arguments: { words: "Hello" },
    name: "ask_main_session",
  });
  expect(json.result).toMatchObject({
    content: [{ text: NOT_HIS }],
    isError: true,
  });
});

test("built to serve reads only (the question cases' agent, a pi agent), the connector registers no tool that writes or acts", async () => {
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
  for (const write of CONNECTOR_WRITES) {
    expect(names).not.toContain(write);
  }
  expect(names).toContain("read_people_and_organizations");
  expect(names).toContain("search");
  // His log is his token's alone: never on a server with no token.
  for (const n of HIS_ONLY) {
    expect(names).not.toContain(n);
  }
});

test("change_directory_entry is his: an agent's token is refused, and `said` is required; truth/ stays as it was", async () => {
  const areas = join(OWNER_DATA_DIR, "truth", "areas.yaml");
  const before = readFileSync(areas, "utf8");
  const call = async (over: Record<string, unknown>, args: object) =>
    (
      await rpc(await token(over), "tools/call", {
        arguments: args,
        name: "change_directory_entry",
      })
    ).json.result;
  const change = { action: "add", kind: "area", name: "Health", said: "x" };
  const agent = await call({}, change);
  expect(agent).toMatchObject({ isError: true });
  expect(agent.content[0].text).toContain("paired as an agent");
  const { said: _, ...unsaid } = change;
  const missing = await call({ agent: undefined }, unsaid);
  expect(missing).toMatchObject({ isError: true });
  expect(missing.content[0].text).toContain("said");
  expect(readFileSync(areas, "utf8")).toBe(before);
});

test("delete_from_memory is his: an agent's token is refused, and `said` is required", async () => {
  const call = async (over: Record<string, unknown>, args: object) =>
    (
      await rpc(await token(over), "tools/call", {
        arguments: args,
        name: "delete_from_memory",
      })
    ).json.result;
  const deletion = { refs: ["unit_000000000000"], said: "that goes" };
  const agent = await call({}, deletion);
  expect(agent).toMatchObject({ isError: true });
  expect(agent.content[0].text).toContain("paired as an agent");
  const { said: _, ...unsaid } = deletion;
  const missing = await call({ agent: undefined }, unsaid);
  expect(missing).toMatchObject({ isError: true });
  expect(missing.content[0].text).toContain("said");
});
