import { expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readChangeStamp, writeJson } from "../../core/files";
import { setSettings } from "../../core/settings";
import { isSealed, type MisreadShown } from "../../memory/complaint-checks";
import { withNetworkIdentity } from "../../memory/network-identity";
import { PERSON_PICTURES, pictureFileOf } from "../../memory/party";
import {
  PROJECT_SITUATIONS,
  projectSituationPath,
  promptNameNow,
} from "../../memory/project-situation-read";
import { Misread } from "../complaints";
import type { WakeLine } from "../registered-agents";
import {
  GRAN_PICTURE,
  kitOnWhatsapp,
  madeUpBase,
  madeUpInbox,
  madeUpPartyOf,
  ROBIN_PICTURE,
} from "./mcp-phone-reads-fixture";
import { rpc, token } from "./mcp-test-harness";
import { expectWire } from "./wire-fixture";

// The phone's reads, as real answers (`wire-fixture.ts`).

test("the phone's reads: read_inbox, read_matters, read_matter, read_registered_agents and read_person_pictures answer what Kit's models decode", async () => {
  const checks = await import("../../memory/checks");
  const who = await import("../../memory/who");
  const book = await import("../../memory/matters");
  const icons = await import("../../memory/matter-icons");
  const items = await import("../../memory/read-open-items");
  const agents = await import("../registered-agents");
  // On: the transfer's look is a payment's (`doneSeenByOf`).
  setSettings({ payments: { backend: "money" } });
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
    notStarted: null,
    outcome: null,
    project: null,
    role: "personal" as const,
    runtime: "claude",
    status: "running" as const,
    statusSince: "2026-10-13T09:00:00.000Z",
    steps: ["obs_000000000005"],
    title: "Get Gran's watch mended",
    wait: null,
    wakesOn: [],
  };
  // Waiting: one line of each kind (`wakesOnOf`).
  const waiting = {
    ...agent,
    id: "agt_000000000002",
    link: null,
    model: null,
    project: "shop-fit-out",
    role: null,
    status: "waiting" as const,
    statusSince: "2026-10-14T09:00:00.000Z",
    steps: [],
    wait: {
      isDefault: false,
      reason: "his answer",
      until: "2026-10-16T09:00:00.000Z",
    },
    wakesOn: [
      {
        calls: true,
        kind: "message",
        party: madeUpPartyOf("person:gran"),
        personAsWritten: "Gran",
      },
      {
        apps: ["whatsapp"],
        calls: true,
        chat: { app: "whatsapp", group: true, name: "Shop fit-out" },
        kind: "message",
      },
      {
        broken: "unknown_person",
        calls: true,
        kind: "message",
        personAsWritten: "Kit",
      },
      { calls: false, fromHim: true, kind: "message", words: "quote" },
      { above: 100, kind: "payments", quantity: "eur_out", words: "shop" },
      {
        kind: "places",
        near: { latitude: 10.5, longitude: 20.5, radius_m: 100 },
      },
      {
        card: "Book the shop?",
        check: "dec_000000000001",
        deadline: "2026-10-15T09:00:00.000Z",
        kind: "answer",
      },
      { kind: "wide_net" },
    ] as WakeLine[],
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
    waitingOn: [],
    with: [],
    ...over,
  });
  const spies = [
    // Every kind of check, as Life's own builders make them over made-up records (`checksOf`), never by hand.
    spyOn(checks, "checksAndKeyNow").mockImplementation(async () => ({
      // As the inbox shows them (`inboxChecksOf`: push ids, urgency, the "Wrong…" sealed), under a made-up key.
      checks: checks.inboxChecksOf(
        checks.checksOf(madeUpInbox).map((c) =>
          // Kit's guess, as its newest WhatsApp chat shows it (`networkIdentityOf` over a made-up chat-day).
          withNetworkIdentity(c, kitOnWhatsapp, {
            nameOf: () => "Dana",
            partyOf: madeUpPartyOf,
            resolve: madeUpBase.people.resolve,
          })
        ),
        "0".repeat(64)
      ),
      // The key moves with the project situations, as the real one does (`CHECKS_READ`).
      key: `the phone's reads ${readChangeStamp([PROJECT_SITUATIONS])}`,
    })),
    spyOn(who, "readPeople").mockResolvedValue({
      isGuess: () => false,
      isKnownToHim: () => true,
      nameOf: (r: string) => r.replace("person:", ""),
      partyOf: madeUpPartyOf,
      truth: {
        areas: [],
        me: { goals: "1. The shop opens in spring (`shop-fit-out`)." },
        projects: [
          { id: "shop-fit-out", name: "Shop fit-out", status: "active" },
        ],
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
        important: true,
        name: "Mend Gran's watch",
        newestOpenStep: steps[1],
        nextStep: {
          at: "2026-10-13T09:00:00.000Z",
          by: "owner",
          // His word's context: on read_matter only, never in read_matters' list.
          context: "The shop said Friday ([the call](life:obs_000000000005)).",
          kind: "wait_event",
          text: "The shop's quote",
          waitsOn: "the shop",
        },
        owedTo: ["person:gran"],
        ownerIcon: "tools",
        projects: ["shop-fit-out"],
        status: "moving",
        steps,
        with: ["person:partner"],
      }),
      view({
        id: "matter_cccccccccccc",
        name: "Frame Gran's photo",
        status: "moving",
        steps: [],
      }),
      view({
        id: "matter_bbbbbbbbbbbb",
        name: "Renew the lease",
        status: "waiting_on_someone",
        steps: [],
      }),
    ] as never),
    spyOn(icons, "iconWorkEnded").mockReturnValue(0),
    // Life's pick for the lease; none for the photo (the phone shows its area's icon).
    spyOn(icons, "readLifeIcons").mockImplementation(
      async (vs) =>
        new Map(
          vs.some((v) => v.id === "matter_bbbbbbbbbbbb")
            ? [["matter_bbbbbbbbbbbb", "key"]]
            : []
        )
    ),
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
        { ...waiting, matter: null },
      ],
      desk: "ok",
      helper: "running",
      refused: [],
    }),
    spyOn(agents, "readActiveAgentOf").mockReturnValue(
      Object.assign(
        (s: string[]) =>
          s.includes("obs_000000000005") ? "agt_000000000001" : undefined,
        { stamp: "made-up" }
      )
    ),
    spyOn(agents, "readAgentsOnSteps").mockReturnValue([
      agent,
      waiting,
    ] as never),
  ];
  try {
    const read = async (name: string, args: object = {}) => {
      // As the phone calls: the 2026-07-28 headers and the per-request envelope (`LifeConnector`'s `MCPClient`).
      const { json } = await rpc(
        await token({ agent: undefined, client_id: "phone" }),
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
    const inbox = await read("read_inbox");
    expectWire("read_inbox", inbox);
    const shown = JSON.parse(inbox).checks as Record<string, unknown>[];
    expect(
      shown.find((c) => c.group === "contacts card")?.contactsCard
    ).toEqual({ handles: ["+33600000009"], name: "Lou" });
    expect(
      shown.find((c) => c.kind === "decision" && c.draft)?.networkIdentity
    ).toMatchObject({ network: "WhatsApp", newest: null, shownName: "Kit" });
    expect(shown.find((c) => c.kind === "decision" && c.draft)?.head).toEqual({
      name: "Kit",
      network: "WhatsApp",
    });
    // Each "Wrong…" as the phone reads it is one Life sealed: sent back with his tick, the server takes it; a nested
    // confirm's is its twin's at the top, so a press on either is the same press.
    const asSent = (ref: unknown, m: unknown) =>
      isSealed(String(ref), m as MisreadShown, "0".repeat(64)) &&
      Misread.safeParse({ ...(m as object), kind: "misread", report: false })
        .success;
    const ownCards = shown.filter((c) => c.misread);
    expect(ownCards.length).toBeGreaterThan(0);
    expect(ownCards.every((c) => asSent(c.ref, c.misread))).toBe(true);
    const nested = shown.flatMap(
      (c) => c.confirm as { misread: unknown; ref: string }[]
    );
    expect(nested.length).toBeGreaterThan(0);
    for (const x of nested) {
      expect(asSent(x.ref, x.misread)).toBe(true);
      expect(x.misread).toEqual(shown.find((c) => c.ref === x.ref)?.misread);
    }
    const matters = await read("read_matters");
    expectWire("read_matters", matters);
    const rows: { icon?: object; name: string }[] = JSON.parse(matters).matters;
    expect(Object.fromEntries(rows.map((m) => [m.name, m.icon]))).toEqual({
      "Frame Gran's photo": undefined,
      "Mend Gran's watch": { by: "owner", key: "tools" },
      "Renew the lease": { by: "life", key: "key" },
    });
    const matterVersion = JSON.parse(matters).version;
    expect(
      JSON.parse(await read("read_matters", { ifNot: matterVersion }))
    ).toEqual({ unchanged: true, version: matterVersion });
    expect(
      JSON.parse(await read("read_matters", { ifNot: "older" })).matters
    ).toEqual(rows);
    // The project head with a made-up situation: shown while a matter of the project holds the step it cites.
    const emptyVersion = JSON.parse(
      await read("read_matters", { project: "shop-fit-out" })
    ).version;
    writeJson(projectSituationPath("shop-fit-out"), {
      built: "2026-10-14T00:00:00.000Z",
      inputs: "0123456789abcdef",
      lines: [
        {
          cites: ["obs_000000000005"],
          text: "The shop is quoting the watch repair; the call to them is done.",
        },
        { cites: ["obs_gonegonegone"], text: "A step no matter holds." },
      ],
      madeBy: {
        engine: "claude",
        model: "m",
        prompt: promptNameNow(),
        run: "r",
      },
      project: "shop-fit-out",
      schemaVersion: 1,
    });
    const withSituation = await read("read_matters", {
      project: "shop-fit-out",
    });
    expect(JSON.parse(withSituation).project.situation).toEqual([
      {
        cites: ["obs_000000000005"],
        text: "The shop is quoting the watch repair; the call to them is done.",
      },
    ]);
    expectWire("read_matters_project", withSituation);
    // A phone that held the empty head hears the new situation.
    expect(
      JSON.parse(
        await read("read_matters", {
          ifNot: emptyVersion,
          project: "shop-fit-out",
        })
      ).unchanged
    ).toBeUndefined();
    rmSync(projectSituationPath("shop-fit-out"), { force: true });
    expectWire(
      "read_matter",
      await read("read_matter", { id: "matter_aaaaaaaaaaaa" })
    );
    expectWire(
      "read_matter_found",
      await read("read_matter", { id: "matter_cccccccccccc" })
    );
    expectWire("read_registered_agents", await read("read_registered_agents"));
    mkdirSync(PERSON_PICTURES, { recursive: true });
    writeFileSync(
      join(PERSON_PICTURES, pictureFileOf(GRAN_PICTURE)),
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    );
    expectWire(
      "read_person_pictures",
      await read("read_person_pictures", {
        ids: [GRAN_PICTURE, ROBIN_PICTURE],
      })
    );
  } finally {
    setSettings({ payments: null });
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
});
