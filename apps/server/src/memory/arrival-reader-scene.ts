import { afterAll, beforeAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, MIN } from "../core/clock";
import type { FoundationAnswer } from "../models/foundation-model";
import { stamp } from "../models/llm";
import type { SourceEvent } from "../records/source";
import type { Unit } from "../records/unit";
import { turnRef } from "../sources/lifelog";
import { type RecentVoice, readArrivals } from "./arrival-reader";
import type { SourceLine } from "./quote-check";
import { readReplies } from "./read-replies";
import { OWNER } from "./read-truth";
import { voiceUnitId } from "./unit-ids";
import { applyRules, messageUnits } from "./units";
import { localDate } from "./zones";

// The arrival reader tests' scene: made-up chats and mail with Sam, someone he knows; Apple and his engine are fakes counting their calls.
export const SAM = "33600000001@s.whatsapp.net";
export const SAM_MAIL = "sam@example.com";
export const known = (h: string) =>
  h === SAM || h === SAM_MAIL ? "person:sam" : null;
export const ago = (minutes: number) =>
  new Date(clock().getTime() - minutes * MIN).toISOString();
let n = 0;
export const msg = (
  text: string,
  over: Partial<SourceEvent> = {}
): SourceEvent => {
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
/** A made-up mail from Sam in one thread: Apple sieves mail alone, chats and voice go straight to his engine. */
export const mail = (
  text: string,
  over: Partial<SourceEvent> = {}
): SourceEvent => {
  const m = msg(text, {
    chat: "thread-1",
    chatName: "Slides",
    sender: SAM_MAIL,
    source: "mail",
    ...over,
  });
  return { ...m, id: over.id ?? m.id.replace("whatsapp", "mail") };
};
export const people = { nameOf: (r: string) => r, resolve: known };

let dir = "";
let trial = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "arrival-reader-"));
});
afterAll(() => rm(dir, { force: true, recursive: true }));

/** His engine's confirm saying one normal ask is left; the default answer. */
export const ASK = {
  event: "no",
  inProgress: [],
  left: [{ kind: "ask", priority: "normal", what: "send it" }],
};
/** His engine's confirm saying nothing is left. */
export const NOTHING = { event: "no", inProgress: [], left: [] };

/** A scene: its own replies folder, Apple answering `apple`, his engine answering `confirm`, both counted. */
export const sceneOf = (
  apple: (text: string) => FoundationAnswer,
  confirm: object = ASK,
  /** His engine fails its first call. */
  failsFirst = false,
  /** His engine's answer to an appointment read, or a call that may fail. */
  meeting: object | (() => Promise<object>) = { agreed: false }
) => {
  trial += 1;
  const where = join(dir, `trial-${trial}`);
  const calls = { apple: 0, engine: 0 };
  const step = {
    ask: (q: {
      input: { firstDay?: string; lines: string[]; now?: string };
    }) => {
      shown.push(q.input.lines.join("\n"));
      nows.push(q.input.now ?? "");
      calls.engine += 1;
      if (failsFirst && calls.engine === 1) {
        return Promise.reject(new Error("engine down"));
      }
      if (!q.input.firstDay) {
        return Promise.resolve(confirm);
      }
      return typeof meeting === "function"
        ? meeting()
        : Promise.resolve(meeting);
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
  const nows: string[] = [];
  /** How many voice units' words each pass fetched. */
  const fetched: number[] = [];
  /** `confirmsToday` null: counted from the model log, as in production. */
  const read = (
    events: SourceEvent[],
    isUp = true,
    confirmsToday: number | null = 0,
    voice?: Voice
  ) =>
    readArrivals(
      {
        built: applyRules(messageUnits(events, known)),
        fileEvents: [],
        ...(voice ? { voice } : {}),
      },
      people,
      ["Ozren"],
      {
        ...(voice?.spoken
          ? {
              spoken: (turns: Map<string, unknown>) => {
                fetched.push(turns.size);
                const spoken = voice.spoken ?? new Map();
                return voice.fails
                  ? Promise.reject(new Error("lifelog unreachable"))
                  : Promise.resolve(spoken);
              },
            }
          : {}),
        apple: (requests) => {
          calls.apple += requests.length;
          return Promise.resolve(requests.map((r) => apple(r.text)));
        },
        ...(confirmsToday === null
          ? {}
          : { confirmsToday: () => Promise.resolve(confirmsToday) }),
        online: () => Promise.resolve(isUp),
        step: () => Promise.resolve(step as never),
        where,
      }
    );
  const lines = () => readReplies(where).flat();
  return { calls, fetched, lines, nows, read, shown, where };
};
/** Today's voice as the reader is given it, and the words its turns' fetch gives back. */
export interface Voice extends RecentVoice {
  /** Fetching the turns' words fails (lifelog unreachable). */
  fails?: boolean;
  spoken?: Map<string, SourceLine[]>;
}
/**
 * A made-up conversation with Sam: `turns` turns of `chars` characters, his own every other one when he spoke, the
 * first `minutesAgo` (default 20) minutes ago.
 */
export const voiceOf = (
  conversation: string,
  o: {
    closed: boolean;
    chars?: number;
    minutesAgo?: number;
    spoke: boolean;
    turns: number;
  }
): Voice & { spoken: Map<string, SourceLine[]> } => {
  const lines = Array.from({ length: o.turns }, (_, i) => {
    const at = ago((o.minutesAgo ?? 20) - i / 10);
    return {
      at,
      ref: turnRef(conversation, i, at),
      speaker: o.spoke && i % 2 === 1 ? OWNER : "person:sam",
      text: `Can you bring the plans? ${"y".repeat(o.chars ?? 20)}`,
    };
  });
  const unit = {
    date: localDate(lines[0]?.at ?? ""),
    end: lines.at(-1)?.at,
    hash: "0123456789abcdef",
    id: voiceUnitId(conversation, localDate(lines[0]?.at ?? "")),
    key: conversation,
    people: o.spoke ? ["person:sam", OWNER] : ["person:sam"],
    refs: [lines[0]?.ref, lines.at(-1)?.ref],
    schemaVersion: 1,
    source: "lifelog",
    start: lines[0]?.at,
    stats: { chars: 0, fromMe: o.spoke ? 1 : 0, items: o.turns },
    title: "Talk",
  } as Unit;
  return {
    built: [{ messages: [], text: "", unit }],
    closed: new Set(o.closed ? [conversation] : []),
    spoken: new Map([[unit.id, lines]]),
    turns: new Map([[unit.id, []]]),
  };
};
export const yes = (quote: string): FoundationAnswer => ({
  os: "27.2",
  reply: { quote, writer: "person" },
});
