import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, MIN } from "../core/clock";
import type { FoundationAnswer } from "../models/foundation-model";
import { stamp } from "../models/llm";
import type { SourceEvent } from "../records/source";
import { readArrivals } from "./arrival-reader";
import { readConfirmedArrivals, readReplies } from "./read-replies";
import { applyRules, messageUnits } from "./units";

// Made-up chats with Sam, someone he knows; Apple and his engine are fakes counting their calls.
const SAM = "33600000001@s.whatsapp.net";
const known = (h: string) => (h === SAM ? "person:sam" : null);
const ago = (minutes: number) =>
  new Date(clock().getTime() - minutes * MIN).toISOString();
let n = 0;
const msg = (text: string, over: Partial<SourceEvent> = {}): SourceEvent => {
  n += 1;
  return {
    at: ago(30 - n / 100),
    chat: SAM,
    fromMe: false,
    id: `whatsapp:${n}`,
    sender: SAM,
    source: "whatsapp",
    text,
    ...over,
  };
};
const people = { nameOf: (r: string) => r, resolve: known };

let dir = "";
let trial = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "arrival-reader-"));
});
afterAll(() => rm(dir, { force: true, recursive: true }));

/** A scene: its own replies folder, Apple answering `apple`, his engine answering `confirm`, both counted. */
const sceneOf = (apple: (text: string) => FoundationAnswer, confirm = true) => {
  trial += 1;
  const where = join(dir, `trial-${trial}`);
  const calls = { apple: 0, engine: 0 };
  const step = {
    ask: (q: { input: { lines: string[] } }) => {
      shown.push(q.input.lines.join("\n"));
      calls.engine += 1;
      return Promise.resolve({ isActionable: confirm });
    },
    attempt: (work: () => Promise<unknown>) => work().catch(() => undefined),
    dir: join(dir, "run"),
    end: (c: object) => c,
    keeps: () => false,
    llm: { engine: "codex", model: "test" },
    madeBy: (prompt: string) =>
      stamp({ engine: "codex", model: "test" }, prompt, "r1"),
    run: "r1",
  };
  const shown: string[] = [];
  const read = (events: SourceEvent[], isUp = true, confirmsToday = 0) =>
    readArrivals(
      { built: applyRules(messageUnits(events, known)), fileEvents: [] },
      people,
      ["Ozren"],
      {
        apple: (requests) => {
          calls.apple += requests.length;
          return Promise.resolve(requests.map((r) => apple(r.text)));
        },
        confirmsToday: () => Promise.resolve(confirmsToday),
        online: () => Promise.resolve(isUp),
        step: () => Promise.resolve(step as never),
        where,
      }
    );
  const lines = () => readReplies(where).flat();
  return { calls, lines, read, shown, where };
};
const yes = (quote: string): FoundationAnswer => ({
  os: "27.2",
  reply: { author: "person", quote },
});

test("Apple's yes goes to his engine; a confirmed yes is a confirmed arrival; a second pass asks nothing", async () => {
  const s = sceneOf(() => yes("send me the lease by Friday"));
  const events = [msg("Can you send me the lease by Friday?")];
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
  expect(s.lines().map((l) => l.read)).toEqual([
    "arrival_trigger",
    "arrival_confirm",
  ]);
  const [confirmed] = readConfirmedArrivals(ago(60), s.where);
  expect(confirmed?.messages).toEqual([`whatsapp|${events[0]?.id}`]);
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
});

test("automated lines with no ask quoted ask his engine nothing; a person's lines go on", async () => {
  const no = sceneOf(() => ({
    os: "27.2",
    reply: { author: "automated", quote: "" },
  }));
  await no.read([msg("Your parcel has shipped")]);
  const person = sceneOf(() => yes(""));
  await person.read([msg("Lovely evening, thanks again")]);
  expect([no.calls.engine, person.calls.engine]).toEqual([0, 1]);
});

test("Thai lines and no Apple model go straight to his engine; a refusal is stored, then confirmed", async () => {
  const thai = sceneOf(() => yes("unused"));
  await thai.read([msg("ช่วยส่งเอกสารให้หน่อยได้ไหม")]);
  expect(thai.calls).toEqual({ apple: 0, engine: 1 });
  const none = sceneOf(() => ({ detail: "no helper", error: "unavailable" }));
  await none.read([msg("Can you check the contract?")]);
  expect(none.lines().map((l) => l.read)).toEqual(["arrival_confirm"]);
  const refused = sceneOf(() => ({ detail: "sensitive", error: "refused" }));
  await refused.read([msg("Can you check the contract?")]);
  expect(refused.lines().map((l) => l.read)).toEqual([
    "arrival_trigger",
    "arrival_confirm",
  ]);
});

test("a grown chat is read for its new lines only, a new read of its own", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const first = msg("Can you send the slides?");
  await s.read([first]);
  const second = msg("And send the slides to Ann too?");
  await s.read([first, second]);
  expect(s.lines().map((l) => l.messages)).toEqual([
    [`whatsapp|${first.id}`],
    [`whatsapp|${first.id}`],
    [`whatsapp|${second.id}`],
    [`whatsapp|${second.id}`],
  ]);
});

test("his engine's no is stored and confirms nothing", async () => {
  const s = sceneOf(() => yes("send the slides"), false);
  await s.read([msg("Can you send the slides?")]);
  expect(readConfirmedArrivals(ago(60), s.where)).toEqual([]);
});

test("offline, Apple's yes is stored and its confirm waits; back online, the pending confirm is asked", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const events = [msg("Can you send the slides?")];
  await s.read(events, false);
  expect(s.calls).toEqual({ apple: 1, engine: 0 });
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
  expect(readConfirmedArrivals(ago(60), s.where)).toHaveLength(1);
});

test("a pending confirm reads the same bounded lines Apple read; with one of them gone, it is the night's", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const long = msg(`Can you send the slides? ${"x".repeat(6000)}`);
  await s.read([long], false);
  await s.read([long]);
  expect(s.shown.map((t) => t.length)).toEqual([5000]);
  const gone = sceneOf(() => yes("send the slides"));
  const [a, b] = [msg("Can you send the slides?"), msg("Today if you can")];
  await gone.read([a, b], false);
  await gone.read([b]);
  expect(gone.calls.engine).toBe(0);
});

test("the day's cap counts the confirms already made: at 99, one of two reads is confirmed, the newest", async () => {
  const s = sceneOf(() => yes("send the slides"));
  await s.read(
    [
      msg("Can you send the slides?"),
      msg("Can you send the slides?", {
        chat: "c2",
        id: "whatsapp:c2",
        sender: SAM,
      }),
    ],
    true,
    99
  );
  expect(s.calls.engine).toBe(1);
});
