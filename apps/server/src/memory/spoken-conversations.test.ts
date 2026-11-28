import { afterAll, expect, test } from "bun:test";
import { MIN } from "../core/clock";
import { apply } from "../sources/voice-server";
import { readSpokenTurns } from "../sources/voice-server-conversations";
import {
  conversation,
  voiceServer,
  voiceStore,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import {
  CONVERSATION_PART_CHARS,
  isSummarised,
  SUMMARY_FROM_CHARS,
  spokenConversationsOf,
  spokenPartsOf,
} from "./spoken-conversations";

// Made-up conversations: `n` turns of `size` characters, a minute apart unless a gap says otherwise.
const START = Date.parse("2026-10-14T10:00:00.000Z");
const NOW = new Date("2026-10-15T10:00:00.000Z");
const people = {
  nameOf: (s: string) => s.replace("person:", ""),
  resolve: (name: string) => `person:${name}`,
};

interface Spec {
  at?: number;
  job?: string;
  name?: string | null;
  owner?: boolean;
  speaker: string;
  text: string;
}
interface Kind {
  kind: string;
  speakerLabel: string;
  withOwner: boolean;
}

let server: ReturnType<typeof voiceServer> | undefined;
afterAll(() => server?.close());

/** A store holding `specs` as conversation c1 (turns numbered per job), lifelog answering its words and `kinds`. */
const sceneOf = (specs: Spec[], kinds: Kind[] = []) => {
  const jobs = new Map<string, Spec[]>();
  const turns = specs.map((s, n) => {
    const job = s.job ?? "job-1";
    const list = jobs.get(job) ?? [];
    list.push(s);
    jobs.set(job, list);
    const at = new Date(START + (s.at ?? n * MIN)).toISOString();
    return {
      ...turnFixture(
        list.length - 1,
        at,
        s.name ? "p1" : null,
        s.name ?? null,
        "c1",
        !!s.owner
      ),
      jobId: job,
    };
  });
  server?.close();
  server = voiceServer({
    "/conversations/c1": () => ({
      latestRun: {
        result: {
          speakerIdentities: kinds.map((k) => ({ ...k, jobId: "job-1" })),
        },
      },
    }),
    ...Object.fromEntries(
      [...jobs].map(([job, list]) => [
        `/transcription-jobs/${job}/transcript`,
        () => ({
          turns: list.map((s) => ({ speakerId: s.speaker, text: s.text })),
        }),
      ])
    ),
  });
  const store = voiceStore();
  apply(store, pageFixture({ conversations: [conversation("c1")], turns }));
  return readSpokenTurns(store, new Map());
};
const say = (
  speaker: string,
  size: number,
  extra: Partial<Spec> = {}
): Spec => ({
  speaker,
  text: "w".repeat(size),
  ...extra,
});
/** Enough turns of 1,000 characters for `chars`, him then another voice, alternating. */
const talk = (turns: number, size = 1000, other = "speaker_1") =>
  Array.from({ length: turns }, (_, n) =>
    n % 2 === 0 ? say("speaker_0", size, { owner: true }) : say(other, size)
  );
const partsOf = async (specs: Spec[], kinds: Kind[] = []) =>
  spokenPartsOf(
    (await Promise.resolve(sceneOf(specs, kinds))) as never,
    people
  );

test("a conversation of any length with a line that is not his has parts; it is summarised from 15,000 shown characters", async () => {
  expect(SUMMARY_FROM_CHARS).toBe(15_000);
  const short = await partsOf(talk(10));
  expect(short).toHaveLength(1);
  expect(isSummarised(short)).toBe(false);
  const parts = await partsOf(talk(20));
  expect(parts).toHaveLength(1);
  expect(isSummarised(parts)).toBe(true);
  expect(parts[0]?.lines[0]).toContain("[0] ");
  expect(parts[0]?.lines[0]).toContain(" me: ");
  expect(parts[0]?.lines[1]).toContain(" V1: ");
  // Only his own voice, however long: nothing to summarise.
  expect(
    await partsOf(
      Array.from({ length: 20 }, () => say("speaker_0", 1000, { owner: true }))
    )
  ).toEqual([]);
});

test("screen, nearby and announcement voices are left out; a phone voice and an unclassified one are kept", async () => {
  const specs = [
    ...talk(20),
    say("speaker_2", 5000),
    say("speaker_3", 5000),
    say("speaker_4", 5000),
    say("speaker_5", 5000),
  ];
  const kinds = [
    { kind: "media", speakerLabel: "speaker_2", withOwner: false },
    { kind: "live", speakerLabel: "speaker_3", withOwner: false },
    { kind: "announcement", speakerLabel: "speaker_4", withOwner: false },
    { kind: "phone", speakerLabel: "speaker_5", withOwner: true },
  ];
  const [part] = await partsOf(specs, kinds);
  // 20 turns, plus the phone voice: the three dropped voices add nothing.
  expect(part?.lines).toHaveLength(21);
  expect(part?.lines.at(-1)).toContain("(over the phone)");
  // speaker_1 has no kind at all in lifelog's answer: it is kept.
  expect(part?.lines[1]).toContain(" V1: ");
});

test("a named voice shows by its name, and an unnamed voice is V1, V2 by first line, apart for each recording", async () => {
  const specs = [
    say("speaker_0", 5000, { owner: true }),
    say("speaker_1", 5000, { name: "Dana" }),
    say("speaker_0", 5000, { job: "job-1" }),
    say("speaker_0", 5000, { job: "job-2" }),
    say("speaker_1", 5000, { job: "job-1" }),
  ];
  const [part] = await partsOf(specs);
  const who = part?.lines.map((l) => l.split(" ")[2]);
  expect(who).toEqual(["me:", "Dana:", "V1:", "V2:", "V3:"]);
  expect(part?.people).toEqual(["Dana"]);
});

test("a long conversation is cut into parts of at most 150,000 characters, at its longest silence", async () => {
  expect(CONVERSATION_PART_CHARS).toBe(150_000);
  // 200 turns of 1,000 characters, a minute apart, with a 4-minute silence (still one conversation) after turn 119.
  const specs = talk(200).map((s, n) => ({
    ...s,
    at: n * MIN + (n >= 120 ? 4 * MIN : 0),
  }));
  const parts = await partsOf(specs);
  expect(parts.length).toBeGreaterThanOrEqual(2);
  for (const p of parts) {
    expect(p.chars).toBeLessThanOrEqual(CONVERSATION_PART_CHARS);
  }
  // The cut is at the silence; lines count from 0 in each part.
  expect(parts[0]?.keys).toHaveLength(120);
  expect(parts[1]?.lines[0]).toContain("[0] ");
  expect(parts.flatMap((p) => p.keys)).toHaveLength(200);
});

test("only finished conversations are cut", () => {
  const turns = sceneOf(talk(4)) as never;
  expect(spokenConversationsOf(turns, new Date(START + 6 * MIN))).toHaveLength(
    0
  );
  expect(spokenConversationsOf(turns, NOW)).toHaveLength(1);
});
