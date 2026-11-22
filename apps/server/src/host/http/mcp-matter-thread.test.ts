import { expect, spyOn, test } from "bun:test";
import { madeUpPartyOf } from "./mcp-phone-reads-fixture";
import { rpc, token } from "./mcp-test-harness";
import { expectWire } from "./wire-fixture";

// A matter's thread (`<matter id>/thread`, `readMatterThread`), as the phone reads it through `fetch`.

const GRAN_PHONE = "+33600000001";
const CHAT = "33600000001@s.whatsapp.net";

const fact = (id: string, at: string, channel: string, ref: string) => ({
  at,
  date: at.slice(0, 10),
  id,
  quote: `words of ${id}`,
  source: { channel, ref },
  speaker: "person:gran",
});
const observations = [
  // Two facts of one message: one line.
  fact("obs_000000000001", "2026-10-03T10:00:00Z", "whatsapp", "M1"),
  fact("obs_000000000002", "2026-10-03T10:00:00Z", "whatsapp", "M1"),
  fact("obs_000000000003", "2026-10-04T10:06:00Z", "lifelog", "job-1:3@x"),
  // A message Life can't open now: its quote.
  fact("obs_000000000004", "2026-10-04T12:00:00Z", "whatsapp", "gone"),
  fact("obs_000000000005", "2026-10-05T08:00:00Z", "whatsapp", "C1"),
];
const episode = {
  day: "2026-10-02",
  end: "2026-10-02 12:00",
  id: "ep_000000000001",
  people: [],
  start: "2026-10-02 09:00",
  title: "At the watch shop",
};
const step = (kind: string, ref: string, at: string, text = "") => ({
  at,
  day: at.slice(0, 10),
  kind,
  quote: text,
  ref,
  text,
});
const matter = {
  id: "matter_aaaaaaaaaaaa",
  steps: [
    step("episode", episode.id, "2026-10-02T07:00:00Z"),
    ...observations.map((o) => step("promise", o.id, o.at)),
    step("todo_item", "entry_000000000001", "2026-10-06T09:00:00Z", "Call"),
  ],
};
const message = (id: string, at: string, over: object = {}) => ({
  at,
  chat: CHAT,
  fromMe: false,
  id,
  sender: GRAN_PHONE,
  source: "whatsapp",
  text: "The watch is ready",
  ...over,
});
const events: Record<string, object> = {
  C1: message("C1", "2026-10-05T08:00:00Z", {
    phoneCall: { seconds: 90, video: false },
    text: "",
  }),
  M1: message("M1", "2026-10-03T10:00:00Z"),
};

test("a matter's thread: the lines its facts cite, its moments with their payments, its events and to-do items, in time order", async () => {
  const appointments = await import("../../memory/appointments");
  const refs = await import("../../memory/find-refs");
  const matters = await import("../../memory/matters");
  const payments = await import("../../memory/payments");
  const who = await import("../../memory/who");
  const spies = [
    spyOn(matters, "readMatterBookAndRecords").mockResolvedValue({
      book: [matter],
      records: { episodes: [episode], observations },
    } as never),
    spyOn(who, "readPeople").mockResolvedValue({
      partyOf: madeUpPartyOf,
      resolve: (h: string) => (h === GRAN_PHONE ? "person:gran" : null),
    } as never),
    spyOn(refs, "findMessage").mockImplementation(({ message: id }) =>
      events[id]
        ? ({ event: events[id], found: true, kind: "message" } as never)
        : { found: false, why: "gone" }
    ),
    spyOn(appointments, "readAppointments").mockReturnValue({
      appointments: [
        {
          id: "apt_000000000001",
          observations: ["obs_000000000002"],
          start: "2026-10-09 10:00",
          title: "Pick up the watch",
        },
      ],
    } as never),
    spyOn(payments, "placedOn").mockResolvedValue({
      list: [
        {
          day: "2026-10-02",
          episode,
          payment: {
            amount: -45,
            category: "Repairs",
            currency: "EUR",
            date: "2026-10-02",
            eur: -45,
            id: "pay-1",
            merchant: "Watch Shop",
            note: null,
            paidAt: "2026-10-02T11:00:00+02:00",
            spending: true,
          },
        },
      ],
    } as never),
  ];
  try {
    const read = async (id: string) => {
      const { json } = await rpc(await token(), "tools/call", {
        arguments: { id },
        name: "fetch",
      });
      return json.result.content[0].text as string;
    };
    const page = JSON.parse(await read("matter_aaaaaaaaaaaa/thread"));
    expectWire("fetch_matter_thread", page);
    expect(page.thread.map((l: { kind: string }) => l.kind)).toEqual([
      "moment",
      "payment",
      "message",
      "event",
      "voice",
      "quote",
      "call",
      "todo_item",
    ]);
    // A step's id finds its matter, as `read_matter` does; `before` pages back by whole days.
    const older = JSON.parse(
      await read("obs_000000000003/thread/before/2026-10-03")
    );
    expect(older.matter).toBe("matter_aaaaaaaaaaaa");
    expect(older.thread.map((l: { kind: string }) => l.kind)).toEqual([
      "moment",
      "payment",
    ]);
    expect(await read("matter_bbbbbbbbbbbb/thread")).toContain(
      "(no matter matter_bbbbbbbbbbbb)"
    );
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
});
