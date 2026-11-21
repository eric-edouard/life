import { nameGroupsOf } from "../../memory/check-sentences";
import type { CheckInputs } from "../../memory/checks";
import { nameRow } from "../../memory/checks-test-inputs";
import { networkIdentityOf } from "../../memory/network-identity";
import { partyOf } from "../../memory/party";

// The made-up records behind the phone's reads (`mcp-phone-reads.test.ts`).

/** Gran's person in lifelog, a voice's likely speaker. */
const GRAN_VOICE = "00000000-0000-4000-8000-000000000001";
export const line = (id: string, text: string, over = {}) => ({
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
export const lines = [
  line("obs_000000000005", "Call the shop"),
  line("obs_000000000006", "Kit sends the quote", {
    subjects: ["person:inf_kit"],
  }),
  line("obs_000000000007", "Lou's number changed", {
    subjects: ["person:con_lou"],
  }),
  line("obs_000000000008", "Sam fixed the strap"),
];
export const matter = {
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
export const GRAN_PICTURE = "00000000000000000000000000000a02";
export const ROBIN_PICTURE = "00000000000000000000000000000b01";
export const nameOf = (r: string) =>
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
export const madeUpPartyOf = partyOf(
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
export const kitOnWhatsapp = new Map([
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
/** One check of every kind: a decision with a draft to a guessed person, an ending, a new matter, a guessed person, a Contacts card, a name, a voice, a same person. */
export const madeUpBase: Omit<CheckInputs, "nameGroups"> = {
  answered: new Set(),
  decisions: [
    {
      asker: "Orbit",
      at: "2026-10-13T09:00:00.000Z",
      context:
        "He asked for it by Friday: [his message](life:msg:whatsapp|whatsapp:155@s.whatsapp.net/M1).",
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
        recent: [
          {
            at: "2026-10-12T17:00:00.000Z",
            file: { kind: "photo", name: "IMG_0001.HEIC", size: 1_200_000 },
            sender: { kind: "person", name: "Kit", ref: "person:inf_kit" },
          },
          {
            at: "2026-10-12T17:01:00.000Z",
            sender: { kind: "person", name: "Kit", ref: "person:inf_kit" },
            text: "Can you send the quote?",
          },
        ],
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
    // A transfer whose "I've paid" Life looked for and did not find yet: open again. A registered agent's plan (`planCardsOf`).
    {
      agent: "agt_000000000001",
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
    // A plan card with its steps (`plan`) and what they were gathered from: its options' roles on the wire.
    {
      agent: "agt_000000000001",
      asker: "Orbit",
      at: "2026-10-14T10:00:00.000Z",
      context:
        "## Mend the strap\n1. Ask Kit for the quote\n2. Pay the deposit\n3. Book the repair\n\nWhat I read: [Kit's quote](life:unit_000000000001).",
      deadline: "2099-01-02T09:00:00.000Z",
      gathered: { text: "From Kit's quote and two others" },
      id: "dec_000000000003",
      kind: "asked",
      links: [],
      onSilence: null,
      options: [
        { id: "start", label: "Start the plan" },
        { id: "decline", label: "Not this plan" },
      ],
      plan: [
        {
          by: "agent",
          channel: "whatsapp",
          text: "Ask Kit for the quote",
          when: "today",
        },
        { by: "owner", channel: "payment", text: "Pay the deposit" },
        {
          by: "agent",
          text: "Book the repair",
          when: "once Kit answers, by Thu",
        },
      ],
      question: "Start with this plan?",
      schemaVersion: 3,
      state: "open",
      title: "Mend the strap",
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
      status: "active",
      step: "obs_000000000005",
      whyNotStarted: null,
    },
  ],
  isDirectionDue: () => false,
  isForHandOut: () => false,
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
  plans: new Set(["dec_000000000002", "dec_000000000003"]),
  samePersons: [
    {
      guess: "person:inf_kit",
      handles: ["+33600000001"],
      lines: ["the watchmaker, +33600000001", "his partner"],
      other: "person:partner",
    },
  ],
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
export const madeUpInbox: CheckInputs = {
  ...madeUpBase,
  nameGroups: nameGroupsOf({
    ...madeUpBase,
    hisUnitsOf: (units) => new Set(units),
    people: { ...madeUpBase.people, corrections: [] },
    unresolved: [nameRow("Sam", "obs_000000000008")],
  }),
};
