import { expect, setSystemTime, test } from "bun:test";
import { clock, daysBefore, HOUR, iso, MIN } from "../core/clock";
import { log } from "../core/log";
import type { FoundationAnswer } from "../models/foundation-model";
import { CONFIRMS_A_DAY } from "./arrival-reader";
import {
  ASK,
  ago,
  mail,
  msg,
  NOTHING,
  SAM,
  sceneOf,
  yes,
} from "./arrival-reader-scene";
import { READS, readConfirmedArrivals } from "./read-replies";
import { dayNow, dayStart, time } from "./zones";

test("Apple's yes on a mail goes to his engine; a confirmed yes is a confirmed arrival; a second pass asks nothing", async () => {
  const s = sceneOf(() => yes("send me the lease by Friday"));
  const events = [mail("Can you send me the lease by Friday?")];
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
  expect(s.lines().map((l) => l.read)).toEqual([
    "arrival_trigger",
    "arrival_confirm",
  ]);
  const [confirmed] = readConfirmedArrivals(ago(60), s.where);
  expect(confirmed?.messages).toEqual([`mail|${events[0]?.id}`]);
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
});

test("Apple sieves mail: an automated mail needing nothing asks his engine nothing; one that needs him, or a person's, goes on", async () => {
  const automatedOf = (needs: string) =>
    sceneOf(() => ({ os: "27.2", reply: { needs, writer: "automated" } }));
  const notice = automatedOf("no");
  await notice.read([mail("Your order has shipped")]);
  const bill = automatedOf("yes");
  await bill.read([mail("Your invoice is due: pay it by Friday")]);
  const person = sceneOf(() => yes(""));
  await person.read([mail("Lovely evening, thanks again")]);
  expect([notice, bill, person].map((s) => s.calls.engine)).toEqual([0, 1, 1]);
});

test("Apple is shown each unread mail's sender and its start; a mail holding his own line goes straight to the confirm", async () => {
  const texts: string[] = [];
  const s = sceneOf((text) => {
    texts.push(text);
    return yes("");
  });
  const first = mail("Can we meet on Friday?");
  await s.read([first]);
  await s.read([first, mail(`Or Monday ${"x".repeat(700)}`)]);
  expect(texts).toEqual([
    "From: sam@example.com\nCan we meet on Friday?",
    `From: sam@example.com\nOr Monday ${"x".repeat(590)}`,
  ]);
  const his = sceneOf(() => yes(""));
  await his.read([
    mail("I will send the signed lease tomorrow", {
      fromMe: true,
      sender: "me@mine.test",
    }),
  ]);
  expect(his.calls).toEqual({ apple: 0, engine: 1 });
});

test("chats go straight to his engine's confirm alone, never to Apple; a chat that sets a meeting is read by the appointment read on the next pass", async () => {
  const s = sceneOf(
    () => yes("unused"),
    { ...ASK, event: "yes" },
    false,
    dinner()
  );
  const events = [msg("Can you check the contract? Dinner at 19:30")];
  expect(await s.read(events)).toBe(0);
  expect(s.calls).toEqual({ apple: 0, engine: 1 });
  expect(s.lines().map((l) => l.read)).toEqual(["arrival_confirm"]);
  expect(await s.read(events)).toBe(1);
  expect(s.calls).toEqual({ apple: 0, engine: 2 });
  expect(s.lines().map((l) => l.read)).toEqual([
    "arrival_confirm",
    "arrival_appointment",
  ]);
  // Both made, on the same keys: a third pass asks nothing.
  expect(await s.read(events)).toBe(0);
  expect(s.calls.engine).toBe(2);
});

test("Thai mail and no Apple model go straight to the confirm; a refusal is stored, then both reads follow", async () => {
  const thai = sceneOf(() => yes("unused"));
  await thai.read([mail("ช่วยส่งเอกสารให้หน่อยได้ไหม")]);
  expect(thai.calls).toEqual({ apple: 0, engine: 1 });
  const none = sceneOf(() => ({ detail: "no helper", error: "unavailable" }));
  await none.read([mail("Can you check the contract?")]);
  expect(none.calls).toEqual({ apple: 1, engine: 1 });
  expect(none.lines().map((l) => l.read)).toEqual(["arrival_confirm"]);
  const refused = sceneOf(() => ({ detail: "sensitive", error: "refused" }));
  await refused.read([mail("Can you check the contract?")]);
  // His engine's two reads run at once: stored in either order.
  expect(
    refused
      .lines()
      .map((l) => l.read)
      .toSorted()
  ).toEqual(["arrival_appointment", "arrival_confirm", "arrival_trigger"]);
});

/** His engine agreeing on a made-up dinner two days ahead, quoting the booking line. */
const dinner = () => {
  const day = daysBefore(dayNow(), -2);
  return {
    agreed: true,
    allDay: false,
    end: null,
    link: null,
    people: ["Sam"],
    place: "Riverside",
    quote: "table for 2 is booked",
    start: `${day} 19:30`,
    title: "Dinner with Sam",
    zone: null,
  };
};
test("a meeting goes to the appointment read alone, apart from the ask rule: an automated booking asks no confirm and is still read", async () => {
  const s = sceneOf(
    () => ({
      os: "27.2",
      reply: { event: "yes", writer: "automated" },
    }),
    ASK,
    false,
    dinner()
  );
  const events = [mail("Your table for 2 is booked at Riverside, 19:30")];
  expect(await s.read(events)).toBe(1);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
  const read = s.lines().find((l) => l.read === "arrival_appointment");
  expect(read?.reply).toEqual({
    ...dinner(),
    end: `${dinner().start.slice(0, 10)} 20:30`,
  });
  // Read once: a second pass asks nothing and syncs nothing.
  expect(await s.read(events)).toBe(0);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
});

test("an ask and a meeting in one read go to both reads; offline, both wait and are asked on the next pass", async () => {
  const s = sceneOf(
    () => ({
      os: "27.2",
      reply: { event: "yes", needs: "yes", writer: "person" },
    }),
    ASK,
    false,
    dinner()
  );
  const events = [mail("Table for 2 is booked at 19:30, bring the plans")];
  expect(await s.read(events, false)).toBe(0);
  expect(s.calls).toEqual({ apple: 1, engine: 0 });
  expect(await s.read(events)).toBe(1);
  expect(s.calls).toEqual({ apple: 1, engine: 2 });
});

test("a grown chat is read for its new lines only, a new read of its own", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const first = mail("Can you send the slides?");
  await s.read([first]);
  const second = mail("And send the slides to Ann too?");
  await s.read([first, second]);
  expect(s.lines().map((l) => l.messages)).toEqual([
    [`mail|${first.id}`],
    [`mail|${first.id}`],
    [`mail|${second.id}`],
    [`mail|${second.id}`],
  ]);
});

test("a 12,000-character thread is read as 3 chunks in one pass; offline, each pending chunk is re-cut exactly", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const thread = Array.from({ length: 12 }, () =>
    mail(`Can you send the slides? ${"z".repeat(970)}`)
  );
  await s.read(thread, false);
  expect(s.calls).toEqual({ apple: 3, engine: 0 });
  await s.read(thread);
  expect(s.calls).toEqual({ apple: 3, engine: 3 });
  const keysOf = (read: string) =>
    s
      .lines()
      .filter((l) => l.read === read)
      .map((l) => l.messages);
  // Each confirm reads exactly one trigger's lines (asked newest first).
  expect(keysOf("arrival_confirm").map(String).toSorted()).toEqual(
    keysOf("arrival_trigger").map(String).toSorted()
  );
  expect(keysOf("arrival_trigger").flat()).toEqual(
    thread.map((m) => `mail|${m.id}`)
  );
});

test("Apple failing (an outage) stores nothing and asks no confirm: the read is due again on the next pass", async () => {
  const answers: FoundationAnswer[] = [
    { detail: "ModelManagerError 1013", error: "failed" },
    yes("send the slides"),
  ];
  const s = sceneOf(() => answers.shift() ?? yes(""));
  const events = [mail("Can you send the slides?")];
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 0 });
  expect(s.lines()).toEqual([]);
  await s.read(events);
  expect(s.calls).toEqual({ apple: 2, engine: 1 });
});

test("his engine's no is stored and confirms nothing", async () => {
  const s = sceneOf(() => yes("send the slides"), NOTHING);
  await s.read([mail("Can you send the slides?")]);
  expect(readConfirmedArrivals(ago(60), s.where)).toEqual([]);
});

test("offline, Apple's yes is stored and its confirm waits; back online, the pending confirm is asked", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const events = [mail("Can you send the slides?")];
  await s.read(events, false);
  expect(s.calls).toEqual({ apple: 1, engine: 0 });
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
  expect(readConfirmedArrivals(ago(60), s.where)).toHaveLength(1);
});

test("a pending confirm reads the same lines as the trigger; with one of them gone, it is the night's", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const long = mail(`Can you send the slides? ${"x".repeat(6000)} END-MARK`);
  await s.read([long], false);
  await s.read([long]);
  // The confirm reads the long line whole, the same line as before Life went offline.
  expect(s.shown).toHaveLength(1);
  expect(s.shown[0]?.endsWith("END-MARK")).toBe(true);
  const gone = sceneOf(() => yes("send the slides"));
  const [a, b] = [mail("Can you send the slides?"), mail("Today if you can")];
  await gone.read([a, b], false);
  await gone.read([b]);
  expect(gone.calls.engine).toBe(0);
});

/** Two chats' asks, the second newer: under the cap's last room, only the newest is confirmed. */
const twoAsks = () => [
  mail("Can you send the slides?"),
  mail("Can you send the budget?", { chat: "c2", id: "mail:c2" }),
];
test("an appointment read that fails is not counted, and is asked again on its own lines alone, new lines read apart", async () => {
  let fails = true;
  // Apple's answer this pass: a refusal at first (both reads follow), then back.
  const apple: FoundationAnswer[] = [{ detail: "sensitive", error: "refused" }];
  const s = sceneOf(
    () => apple[0] as FoundationAnswer,
    ASK,
    false,
    () => {
      if (fails) {
        fails = false;
        return Promise.reject(new Error("engine down"));
      }
      return Promise.resolve(dinner());
    }
  );
  const a = mail("Your table for 2 is booked at Riverside, 19:30");
  expect(await s.read([a])).toBe(0);
  expect(s.lines().map((l) => l.read)).toEqual([
    "arrival_trigger",
    "arrival_confirm",
  ]);
  // A new line in the same thread, Apple back and saying it is automated with no meeting: the failed read is asked on
  // the first line's keys alone, once; the new line is Apple's alone.
  apple[0] = {
    os: "27.2",
    reply: { event: "no", writer: "automated" },
  };
  const b = mail("See you there");
  expect(await s.read([a, b])).toBe(1);
  expect(await s.read([a, b])).toBe(0);
  expect(
    s
      .lines()
      .map((l) => `${l.read} ${l.messages.join(",")}`)
      .toSorted()
  ).toEqual(
    [
      `arrival_appointment mail|${a.id}`,
      `arrival_confirm mail|${a.id}`,
      `arrival_trigger mail|${a.id}`,
      `arrival_trigger mail|${b.id}`,
    ].toSorted()
  );
});

test("the day's cap counts both reads: one short of it, an ask and a meeting in one read make one call, the newest", async () => {
  const s = sceneOf(
    () => ({
      os: "27.2",
      reply: { event: "yes", needs: "yes", writer: "person" },
    }),
    ASK,
    false,
    dinner()
  );
  await s.read(
    [mail("Can you send it? Table booked for 19:30")],
    true,
    CONFIRMS_A_DAY - 1
  );
  expect(s.calls.engine).toBe(1);
});

test("the day's cap counts the confirms already made: one short of it, one of two reads is confirmed, the newest", async () => {
  const s = sceneOf(() => yes("send it"));
  await s.read(twoAsks(), true, CONFIRMS_A_DAY - 1);
  expect(s.shown).toEqual([expect.stringContaining("the budget")]);
});

test("who wrote the confirmed lines: his own promise in a 1:1 chat names the other person, in a group no one", async () => {
  const peopleOf = async (chat: string) => {
    const s = sceneOf(() => yes("unused"));
    const earlier = msg("Morning Ozren", { chat });
    await s.read([earlier]);
    await s.read([
      earlier,
      msg("I'll send it tonight", { chat, fromMe: true, sender: "me" }),
    ]);
    // The newest confirmed arrival is the one holding his promise.
    return readConfirmedArrivals(ago(60), s.where).at(-1)?.people;
  };
  expect(await peopleOf(SAM)).toEqual(["person:sam"]);
  expect(await peopleOf("120363000000000001@g.us")).toEqual([]);
});

test("a chat read shows the confirm the whole sitting, an answered line of the other person included, and the time now", async () => {
  const s = sceneOf(() => yes("unused"));
  await s.read([
    msg("Can you send the lease?", { at: ago(40) }),
    msg("Sent it", { at: ago(35), fromMe: true, sender: "me" }),
    msg("And the budget?", { at: ago(30) }),
  ]);
  expect(s.calls).toEqual({ apple: 0, engine: 1 });
  expect(s.shown[0]?.split("\n")).toEqual([
    expect.stringContaining("Can you send the lease?"),
    expect.stringContaining("Sent it"),
    expect.stringContaining("And the budget?"),
  ]);
  expect(s.nows).toEqual([time(clock().toISOString())]);
});

test("two unread lines 7 hours apart are two reads, each shown its own sitting: a stored line is always one the confirm saw", async () => {
  const base = dayStart(dayNow()).getTime() + HOUR;
  setSystemTime(new Date(base + 8 * HOUR));
  try {
    const s = sceneOf(() => yes("unused"));
    await s.read([
      msg("Can you call me about the lease?", { at: iso(base) }),
      msg("Also, the budget is due Friday", { at: iso(base + 7 * HOUR) }),
    ]);
    expect(s.calls).toEqual({ apple: 0, engine: 2 });
    expect(s.shown.toSorted()).toEqual([
      expect.stringContaining("Can you call me about the lease?"),
      expect.stringContaining("Also, the budget is due Friday"),
    ]);
    expect(s.shown.every((t) => t.split("\n").length === 1)).toBe(true);
  } finally {
    setSystemTime();
  }
});

test("a confirm leaving only a low thing is stored and kept, but does not wake", async () => {
  const low = {
    ...ASK,
    left: [{ kind: "ask", priority: "low", what: "send it" }],
  };
  const s = sceneOf(() => yes("unused"), low);
  await s.read([msg("Can you send the lease?")]);
  expect(readConfirmedArrivals(ago(60), s.where)).toEqual([
    expect.objectContaining({ wakes: false }),
  ]);
});

test("a confirm that saw him in the middle of something is read again once the chat has been quiet 6 hours, and not a third time", async () => {
  const base = dayStart(dayNow()).getTime() + HOUR;
  const middle = { ...NOTHING, inProgress: ["answering the lease"] };
  const s = sceneOf(() => yes("unused"), middle);
  const events = [
    msg("Can you send the lease?", { at: iso(base) }),
    msg("Looking now", { at: iso(base + MIN), fromMe: true, sender: "me" }),
  ];
  try {
    setSystemTime(new Date(base + 40 * MIN));
    await s.read(events);
    expect(s.calls.engine).toBe(1);
    setSystemTime(new Date(base + 2 * HOUR));
    await s.read(events);
    expect(s.calls.engine).toBe(1);
    setSystemTime(new Date(base + 7 * HOUR));
    await s.read(events);
    expect(s.calls.engine).toBe(2);
    // The new read is on the same keys.
    const [first, again] = s.lines().map((l) => l.messages);
    expect(again).toEqual(first);
    await s.read(events);
    expect(s.calls.engine).toBe(2);
  } finally {
    setSystemTime();
  }
});

// Last: it fills today's model log.
test("the day's cap counts the confirm calls in the model log, failed ones included", async () => {
  for (let i = 0; i < CONFIRMS_A_DAY - 1; i += 1) {
    log("model.run", {
      at: iso(clock().getTime()),
      ok: false,
      prompt: READS.arrival_confirm.prompt,
    });
  }
  const s = sceneOf(() => yes("send it"));
  await s.read(twoAsks(), true, null);
  expect(s.shown).toEqual([expect.stringContaining("the budget")]);
});
