import { expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setSettings } from "../../core/settings";
import { nameGroupsOf } from "../../memory/check-sentences";
import { urgencyOf } from "../../memory/check-urgency";
import type { CheckInputs } from "../../memory/checks";
import { nameRow } from "../../memory/checks-test-inputs";
import { buildIndex } from "../../memory/index-writer";
import { INDEX, UNITS } from "../../memory/memory-files";
import {
  networkIdentityOf,
  withNetworkIdentity,
} from "../../memory/network-identity";
import { PERSON_PICTURES, partyOf, pictureFileOf } from "../../memory/party";
import { unit as unitFixture } from "../../memory/record-fixtures";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as sources from "../../memory/sources";
import type { SourceEvent } from "../../records/source";
import type { WakeLine } from "../registered-agents";
import { rpc, token } from "./mcp-test-harness";
import { expectWire } from "./wire-fixture";

// The phone's reads, as real answers (`wire-fixture.ts`).

/** Gran's person in lifelog, a voice's likely speaker. */
const GRAN_VOICE = "00000000-0000-4000-8000-000000000001";
const line = (id: string, text: string, over = {}) => ({
  about: undefined,
  confidence: 0.9,
  date: "2026-10-12",
  id,
  quote: `"${text}" said Gran`,
  source: { channel: "whatsapp" as const },
  speaker: "person:gran",
  subjects: [],
  text,
  unit: "unit_000000000001",
  ...over,
});
const lines = [
  line("obs_000000000005", "Call the shop"),
  line("obs_000000000006", "Kit sends the quote", {
    subjects: ["person:inf_kit"],
  }),
  line("obs_000000000007", "Lou's number changed", {
    subjects: ["person:con_lou"],
  }),
  line("obs_000000000008", "Sam fixed the strap"),
];
const matter = {
  lone: false,
  open: true,
  owedTo: [],
  projects: [] as string[],
  status: "moving" as const,
  waitingOn: [],
  with: [],
};
const KIT_CHAT = "33600000001@s.whatsapp.net";
/** Gran's WhatsApp picture, his pick for her; Robin's, which he hides. */
const GRAN_PICTURE = "00000000000000000000000000000a02";
const ROBIN_PICTURE = "00000000000000000000000000000b01";
const nameOf = (r: string) =>
  (
    ({
      "person:con_lou": "Lou",
      "person:gran": "Gran",
      "person:inf_kit": "Kit",
      "person:partner": "Robin",
      "person:sam_ito": "Sam Ito",
      "person:sam_lee": "Sam Lee",
    }) as Record<string, string>
  )[r] ?? r;
/** Gran shows two pictures and his pick is her WhatsApp one; Robin shows one, his pick `none`; Sam Lee shows his Contacts one. */
const madeUpPartyOf = partyOf(
  {
    isOrganization: () => false,
    nameOf,
    refOf: (r) => r,
    relationOf: (r) =>
      ({
        "person:gran": "Your grandmother",
        "person:inf_kit": "the watchmaker",
        "person:sam_lee": "The neighbour",
      })[r] ?? null,
  },
  [
    { id: "gran", pictureFrom: "whatsapp" },
    { id: "partner", pictureFrom: "none" },
  ],
  () => ({
    "person:gran": [
      { id: "00000000000000000000000000000a01", source: "contacts" },
      { id: GRAN_PICTURE, source: "whatsapp" },
    ],
    "person:partner": [{ id: ROBIN_PICTURE, source: "contacts" }],
    "person:sam_lee": [
      { id: "00000000000000000000000000000c01", source: "contacts" },
    ],
  })
);
const kitOnWhatsapp = new Map([
  [
    "person:inf_kit",
    {
      ...networkIdentityOf(
        { key: KIT_CHAT, source: "whatsapp", title: "Kit Watches" },
        [
          {
            at: "2026-10-12T09:05:00.000Z",
            fromMe: false,
            sender: "+33600000001",
            text: "Kit here, from the shop",
          },
        ],
        "Dana"
      ),
      party: madeUpPartyOf("person:inf_kit"),
    },
  ],
]);
/** One check of every kind: a decision with a draft to a guessed person, an ending, a new matter, a guessed person, a Contacts card, a name, a voice. */
const madeUpBase: Omit<CheckInputs, "nameGroups"> = {
  answered: new Set(),
  decisions: [
    {
      asker: "Orbit",
      at: "2026-10-13T09:00:00.000Z",
      context: "He asked for it by Friday.",
      deadline: "2099-01-01T09:00:00.000Z",
      draft: {
        channel: "whatsapp",
        chat: "33600000001@s.whatsapp.net",
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
      id: "dec_000000000001",
      kind: "asked",
      links: ["https://agents.example.test/s/1"],
      onSilence: "no",
      options: [
        { id: "yes", label: "Send it", outgoing: true },
        { id: "no", label: "Not now" },
      ],
      question: "Send Kit the signed quote?",
      schemaVersion: 3,
      state: "open",
      subject: "obs_000000000005",
      title: "Kit is waiting for the quote.",
    },
    // A transfer whose "I've paid" Life looked for and did not find yet: open again.
    {
      asker: "Orbit",
      at: "2026-10-14T09:00:00.000Z",
      context: "",
      deadline: "2099-01-02T09:00:00.000Z",
      doneSeen: {
        at: "2026-10-14T10:00:00.000Z",
        id: "dec_000000000002",
        kind: "done-seen",
        schemaVersion: 3,
        state: "not_found",
      },
      doneSeenBy: "payment",
      id: "dec_000000000002",
      kind: "asked",
      links: [],
      needs: [
        {
          bank: "Test Bank",
          holder: "Blue Reef Test Co.",
          kind: "account",
          number: "012-3-45678-9",
        },
        { currency: "THB", kind: "amount", value: 4500 },
        {
          kind: "link",
          url: "https://pay.example.test/i/12",
          vendor: "Reef Pay",
        },
        { copy: true, kind: "text", label: "Reference", text: "DEP-12" },
        { kind: "qr", source: "Reef's WhatsApp of 14 Oct" },
      ],
      onSilence: null,
      options: [
        { id: "paid", label: "I've paid", looks: true },
        { id: "other", label: "Paid another way", takes: "note" },
        { id: "drop", label: "Drop it" },
      ],
      question: "Pay the dive course deposit?",
      schemaVersion: 3,
      state: "open",
      title: "Pay the deposit",
    },
  ],
  dismissed: [],
  doubted: new Set(),
  endings: new Map([
    ["obs_000000000005", { later: "ep_000000000001", quote: "Called them." }],
  ]),
  heldByAgents: [
    {
      agent: "agt_000000000001",
      closedAt: null,
      openedBy: "owner",
      outcome: null,
      project: null,
      status: "active",
      step: "obs_000000000005",
      whyNotStarted: null,
    },
  ],
  isDirectionDue: () => false,
  isForHandOut: () => false,
  isHandOutOn: false,
  isParked: () => false,
  kept: new Set(lines.map((l) => l.id)),
  lines,
  matters: [
    {
      ...matter,
      id: "matter_aaaaaaaaaaaa",
      // His important mark: on the row and on a card's matter.
      important: true,
      name: "Mend Gran's watch",
      steps: [
        {
          at: "2026-10-12T09:00:00.000Z",
          day: "2026-10-12",
          quote: "Call the shop",
          ref: "obs_000000000005",
        },
      ],
    },
    {
      ...matter,
      goal: {
        at: "2026-10-13T02:00:00.000Z",
        by: "life",
        text: "Gran's photo is framed.",
      },
      id: "matter_cccccccccccc",
      name: "Frame Gran's photo",
      newestOpenStep: {
        at: "2026-10-12T02:00:00.000Z",
        day: "2026-10-12",
        kind: "to_do",
        quote: "Gran wants it framed",
        ref: "obs_000000000009",
        text: "Frame Gran's photo",
      },
      nextStep: {
        at: "2026-10-13T02:00:00.000Z",
        by: "life",
        kind: "do",
        text: "Ask the shop for a quote",
      },
      steps: [
        {
          at: "2026-10-12T09:00:00.000Z",
          day: "2026-10-12",
          quote: "Gran wants it framed",
          ref: "unit_000000000002",
        },
      ],
    },
  ],
  nameContexts: new Map([
    [
      "sam",
      {
        after: [
          {
            at: "2026-10-12T09:01:00.000Z",
            by: "You",
            channel: "whatsapp" as const,
            text: "Great, thanks.",
            to: "Gran",
          },
        ],
        before: [
          {
            at: "2026-10-12T09:00:00.000Z",
            by: "Gran",
            channel: "whatsapp" as const,
            text: "The strap broke again.",
            to: "Gran",
          },
        ],
        clips: [
          {
            at: "2026-10-12T09:00:30.000Z",
            audio: { end: 3.5, jobId: "job-2", start: 0.5 },
            text: "Sam fixed the strap.",
            until: "2026-10-12T09:00:33.000Z",
            words: [
              [0, 400, 3],
              [450, 900, 6],
              [950, 1100, 4],
              [1150, 1600, 7],
            ],
          },
        ],
        said: {
          at: "2026-10-12T09:00:30.000Z",
          by: "Gran",
          channel: "whatsapp" as const,
          text: "Sam fixed the strap.",
          to: "Gran",
        },
      },
    ],
  ]),
  paged: new Set(),
  people: {
    ambiguousCards: [
      { card: "person:con_lou", people: ["person:gran", "person:partner"] },
    ],
    candidatesFor: (name: string) =>
      name === "Sam" ? ["person:sam_lee", "person:sam_ito"] : [],
    contacts: [
      {
        card: "con_lou",
        handles: ["+33600000009"],
        id: "person:con_lou",
        name: "Lou",
      },
    ],
    inferred: [
      {
        at: "2026-10-02T10:00:00.000Z",
        confidence: 0.7,
        evidence: [
          { quote: "Kit here, from the shop", unit: "unit_000000000001" },
        ],
        id: "inf_kit",
        name: "Kit",
        namesAndHandles: ["+33600000001"],
        relation: "the watchmaker",
      },
    ],
    isGuess: (ref: string) => ref === "person:inf_kit",
    nameOf,
    names: new Map([["person:con_lou", "Lou"]]),
    partyOf: madeUpPartyOf,
    refOf: (r: string) => r,
    resolve: (s: string) =>
      (
        ({
          [GRAN_VOICE]: "person:gran",
          "+33600000001": "person:inf_kit",
        }) as Record<string, string>
      )[s] ?? null,
  },
  titles: new Map([["unit_000000000001", "Gran"]]),
  today: "2026-10-14",
  voices: [
    {
      clips: [
        {
          at: "2026-10-14T08:00:00.000Z",
          audio: { end: 4.5, jobId: "job-1", start: 1.2 },
          text: "It's the shop, about the watch.",
          until: "2026-10-14T08:00:04.000Z",
          words: [
            [0, 300, 4],
            [350, 500, 4],
            [550, 900, 6],
            [950, 1200, 6],
            [1250, 1400, 4],
            [1450, 1900, 7],
          ],
        },
      ],
      conversations: 2,
      evidence: [
        {
          at: "2026-10-14T08:00:00.000Z",
          conversationId: "c1",
          text: "It's the shop, about the watch.",
        },
      ],
      id: "v1",
      kind: "new_person",
      likely: [GRAN_VOICE],
      name: null,
      personId: null,
      voices: [{ conversationId: "c1", jobId: "job-1", speakerLabel: "A" }],
      words: 40,
    },
  ],
  where: new Map([["unit_000000000001", "whatsapp, 2 Oct"]]),
};
const madeUpInbox: CheckInputs = {
  ...madeUpBase,
  nameGroups: nameGroupsOf({
    ...madeUpBase,
    hisUnitsOf: (units) => new Set(units),
    people: { ...madeUpBase.people, corrections: [] },
    unresolved: [nameRow("Sam", "obs_000000000008")],
  }),
};

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
    runtime: "claude",
    status: "running" as const,
    statusSince: "2026-10-13T09:00:00.000Z",
    steps: ["obs_000000000005"],
    title: "Get Gran's watch mended",
    wait: null,
    wakesOn: [],
  };
  const waiting = {
    ...agent,
    id: "agt_000000000002",
    link: null,
    model: null,
    project: "shop-fit-out",
    status: "waiting" as const,
    statusSince: "2026-10-14T09:00:00.000Z",
    steps: [],
    wait: {
      events: [],
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
    spyOn(checks, "checksNow").mockResolvedValue(
      checks.checksOf(madeUpInbox).map((c) => ({
        // Kit's guess, as its newest WhatsApp chat shows it (`networkIdentityOf` over a made-up chat-day).
        ...withNetworkIdentity(c, kitOnWhatsapp, {
          nameOf: () => "Dana",
          partyOf: madeUpPartyOf,
          resolve: madeUpBase.people.resolve,
        }),
        pushId: checks.pushIdOf(c.ref, "0".repeat(64)),
        urgency: urgencyOf(c),
      }))
    ),
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
    spyOn(agents, "readActiveAgentOf").mockReturnValue((s: string[]) =>
      s.includes("obs_000000000005") ? "agt_000000000001" : undefined
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
    const matters = await read("read_matters");
    expectWire("read_matters", matters);
    const rows: { icon?: object; name: string }[] = JSON.parse(matters).matters;
    expect(Object.fromEntries(rows.map((m) => [m.name, m.icon]))).toEqual({
      "Frame Gran's photo": undefined,
      "Mend Gran's watch": { by: "owner", key: "tools" },
      "Renew the lease": { by: "life", key: "key" },
    });
    expectWire(
      "read_matters_project",
      await read("read_matters", { project: "shop-fit-out" })
    );
    expectWire(
      "read_matter",
      await read("read_matter", { id: "matter_aaaaaaaaaaaa" })
    );
    expectWire(
      "read_matter_found",
      await read("read_matter", { id: "matter_cccccccccccc" })
    );
    expectWire("read_registered_agents", await read("read_registered_agents"));
    // Gran's picture as kept (made-up bytes), and Robin's, gone since.
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

test("people's pictures go to any app he paired, never to a paired agent", async () => {
  const { json } = await rpc(await token(), "tools/call", {
    arguments: { ids: [GRAN_PICTURE] },
    name: "read_person_pictures",
  });
  expect(json.result.isError).toBe(true);
  expect(json.result.content[0].text).toContain("paired as an agent");
});

test("the People tab's reads: read_people_and_organizations' list, a person's and an organization's now, and latest answer as data", async () => {
  // Test Ana's one 1:1 WhatsApp chat-day (made-up), indexed, its messages read from the source's span.
  const chat = "33600000004@s.whatsapp.net";
  const chatDay = unitFixture({
    date: "2026-11-17",
    end: "2026-11-17T09:20:00.000Z",
    id: "unit_00000000000a",
    key: chat,
    people: ["person:test-ana", "person:me"],
    source: "whatsapp",
    start: "2026-11-17T09:14:00.000Z",
    title: "Ana B",
  });
  const said = (at: string, fromMe: boolean, text: string): SourceEvent => ({
    at,
    chat,
    chatName: "Ana B",
    fromMe,
    id: `whatsapp:${chat}/${at}`,
    sender: fromMe ? "me" : "Test Ana",
    source: "whatsapp",
    text,
  });
  const real = sources.sourceOf;
  const spy = spyOn(sources, "sourceOf").mockImplementation(
    (name) =>
      ({
        ...real(name),
        read: () => [
          said("2026-11-17T09:14:00.000Z", false, "Bread for Sunday?"),
          said("2026-11-17T09:20:00.000Z", true, "Two loaves, thanks"),
        ],
      }) as never
  );
  mkdirSync(UNITS, { recursive: true });
  mkdirSync(dirname(INDEX), { recursive: true });
  try {
    writeFileSync(
      join(UNITS, `${chatDay.date}.jsonl`),
      `${JSON.stringify(chatDay)}\n`
    );
    buildIndex(
      [],
      INDEX,
      {
        corrections: [],
        live: new Set(),
        retired: new Map(),
        standing: new Map(),
      },
      [{ unit: chatDay }]
    );
    const read = async (args: object) => {
      const { json } = await rpc(
        await token({ agent: undefined, client_id: "phone" }),
        "tools/call",
        { arguments: args, name: "read_people_and_organizations" }
      );
      expect(json.result.isError).toBe(false);
      return json.result.content[0].text as string;
    };
    expectWire("read_people_and_organizations", await read({}));
    expectWire(
      "read_people_and_organizations_query",
      await read({ query: "ana" })
    );
    const ana = await read({ name: "Test Ana" });
    expect(JSON.parse(ana).reach[0]).toMatchObject({
      accounts: [{ handle: "+33600000004", title: "Ana B" }],
      network: "whatsapp",
    });
    expectWire("read_people_and_organizations_now", ana);
    expectWire(
      "read_people_and_organizations_organization",
      await read({ name: "Test Bakery" })
    );
    const latest = await rpc(
      await token({ agent: undefined, client_id: "phone" }),
      "tools/call",
      { arguments: { id: "person:test-ana/latest" }, name: "fetch" }
    );
    expectWire(
      "read_people_and_organizations_latest",
      latest.json.result.content[0].text
    );
  } finally {
    spy.mockRestore();
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(INDEX, { force: true });
  }
});
