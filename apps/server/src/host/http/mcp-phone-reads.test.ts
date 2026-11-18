import { expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "../../memory/checks";
import { rpc, token } from "./mcp-test-harness";

// The phone's reads, as real answers: what each read tool says on made-up data is `apps/lifelog/fixtures/wire/life/<tool>.json`,
// and Kit's `LifeConnector` tests decode the same files. `WRITE_WIRE=1` rewrites them (as lifelog's `wire.test.ts` does for its own; then `bun run fix`).
const LIFE_WIRE = join(
  import.meta.dir,
  "../../../../lifelog/fixtures/wire/life"
);

function expectWire(name: string, text: string) {
  const file = join(LIFE_WIRE, `${name}.json`);
  const value = JSON.parse(text);
  if (process.env.WRITE_WIRE) {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  expect(value).toEqual(JSON.parse(readFileSync(file, "utf8")));
}

test("the phone's reads: read_inbox, read_matters, read_matter and read_registered_agents answer what Kit's models decode", async () => {
  const checks = await import("../../memory/checks");
  const who = await import("../../memory/who");
  const book = await import("../../memory/matters");
  const items = await import("../../memory/read-open-items");
  const agents = await import("../registered-agents");
  const check = (over: Partial<Check>): Check => ({
    about: [],
    asker: "life",
    at: null,
    clips: [],
    context: null,
    deadline: null,
    draft: null,
    evidence: null,
    group: "name",
    kind: "person",
    likelyPeople: [],
    links: [],
    matter: null,
    notSent: null,
    onSilence: null,
    options: [{ id: "skip", label: "Not now" }],
    question: "Who is Sam?",
    ref: "name:sam",
    ridesOn: { matters: 0, observations: 2, pages: 0 },
    subject: null,
    title: "A name Life cannot place",
    ...over,
  });
  const agent = {
    amber: [],
    effort: "medium",
    id: "agt_000000000001",
    lastTurn: {
      cause: "start",
      endedAt: null,
      outcome: null,
      startedAt: "2026-10-13T09:00:00.000Z",
    },
    link: "https://agents.example.test/s/1",
    model: "model-one",
    notes: "Gran's watch: the shop quotes by Friday.",
    outcome: null,
    project: null,
    runtime: "claude",
    status: "running" as const,
    steps: ["obs_000000000005"],
    title: "Get Gran's watch mended",
    wait: null,
  };
  const step = (kind: string, text: string, day: string, ref: string) => ({
    at: `${day}T10:00:00.000Z`,
    day,
    kind,
    quote: `"${text}" said Gran`,
    ref,
    text,
  });
  const steps = [
    step("episode", "Gran's watch", "2026-10-02", "ep_000000000001"),
    {
      ...step("promise", "Call the shop", "2026-10-12", "obs_000000000005"),
      ending: { at: "2026-10-14T10:00:00.000Z", by: "ticked" },
      with: "person:partner",
    },
  ];
  const view = (over: object) => ({
    areas: [],
    lone: false,
    open: true,
    openSteps: [],
    owedTo: [],
    projects: [],
    told: [],
    waitingOn: [],
    with: [],
    ...over,
  });
  const spies = [
    spyOn(checks, "checksNow").mockResolvedValue([
      check({
        asker: "Orbit",
        context: "He asked for it by Friday.",
        deadline: "2099-01-01T09:00:00.000Z",
        draft: {
          channel: "whatsapp",
          chat: "chat-1",
          file: {
            mime: "application/pdf",
            name: "quote.pdf",
            path: "/tmp/quote.pdf",
            sha256: "0".repeat(64),
            size: 52_000,
          },
          quoted: { sender: "Kit", text: "Can you send the quote?" },
          text: "Here is the signed quote.",
          to: "Kit",
        },
        group: "decision",
        kind: "decision",
        links: ["https://agents.example.test/s/1"],
        matter: { id: "matter_aaaaaaaaaaaa", name: "Mend Gran's watch" },
        onSilence: "no",
        options: [
          { id: "yes", label: "Send it", outgoing: true },
          { id: "no", label: "Not now" },
        ],
        question: "Send Kit the signed quote?",
        ref: "dec_000000000001",
        title: "Kit is waiting for the quote.",
      }),
      check({
        clips: [
          {
            at: "2026-10-14T08:00:00.000Z",
            audio: { end: 4.5, jobId: "job-1", start: 1.2 },
            text: "It's the shop, about the watch.",
            until: "2026-10-14T08:00:04.000Z",
          },
        ],
        group: "voice",
        kind: "voice",
        likelyPeople: [{ name: "Gran", person: "person:gran" }],
        options: [{ id: "person:gran", label: "It is Gran" }],
        question: "Who is this?",
        ref: "voice:v1",
      }),
      check({ group: "name", ref: "name:sam" }),
    ] as never),
    spyOn(who, "readPeople").mockResolvedValue({
      nameOf: (r: string) => r.replace("person:", ""),
      truth: {
        areas: [],
        projects: [{ id: "shop-fit-out", name: "Shop fit-out" }],
      },
    } as never),
    spyOn(items, "rankContextOf").mockReturnValue({
      goals: [],
      levels: new Map(),
    }),
    spyOn(book, "readMatterBook").mockResolvedValue([
      view({
        goal: {
          at: "2026-10-13T02:00:00.000Z",
          by: "life",
          text: "Gran has her watch back",
        },
        id: "matter_aaaaaaaaaaaa",
        name: "Mend Gran's watch",
        newestOpenStep: steps[1],
        nextStep: {
          at: "2026-10-13T09:00:00.000Z",
          by: "owner",
          kind: "wait_event",
          text: "The shop's quote",
          waitsOn: "the shop",
        },
        owedTo: ["person:gran"],
        projects: ["shop-fit-out"],
        status: "moving",
        steps,
        with: ["person:partner"],
      }),
      view({
        id: "matter_bbbbbbbbbbbb",
        name: "Renew the lease",
        status: "waiting_on_someone",
        steps: [],
      }),
    ] as never),
    spyOn(agents, "readRegisteredAgents").mockResolvedValue({
      agents: [
        {
          ...agent,
          matter: {
            id: "matter_aaaaaaaaaaaa",
            name: "Mend Gran's watch",
            status: "moving",
          },
        },
        {
          ...agent,
          id: "agt_000000000002",
          link: null,
          matter: null,
          model: null,
          project: "shop-fit-out",
          status: "waiting",
          steps: [],
          wait: {
            isDefault: false,
            reason: "his answer",
            until: "2026-10-16T09:00:00.000Z",
          },
        },
      ],
      desk: "ok",
      helper: "running",
      refused: [],
    }),
    spyOn(agents, "readActiveAgentOf").mockReturnValue((s: string[]) =>
      s.includes("obs_000000000005") ? "agt_000000000001" : undefined
    ),
    spyOn(agents, "readAgentsOnSteps").mockReturnValue([agent] as never),
  ];
  try {
    const read = async (name: string, args: object = {}) => {
      // As the phone calls: the 2026-07-28 headers and the per-request envelope (`LifeConnector`'s `MCPClient`).
      const { json } = await rpc(
        await token(),
        "tools/call",
        {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "Life for iPhone",
              version: "1",
            },
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          },
          arguments: args,
          name,
        },
        {
          "mcp-method": "tools/call",
          "mcp-name": name,
          "mcp-protocol-version": "2026-07-28",
        }
      );
      expect(json.result.isError).toBe(false);
      return json.result.content[0].text as string;
    };
    expectWire("read_inbox", await read("read_inbox"));
    expectWire("read_matters", await read("read_matters"));
    expectWire(
      "read_matter",
      await read("read_matter", { id: "matter_aaaaaaaaaaaa" })
    );
    expectWire("read_registered_agents", await read("read_registered_agents"));
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
});
