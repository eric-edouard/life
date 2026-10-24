// The one rule for where a conversation stands and why it waits, on its facts alone.
import { expect, test } from "bun:test";
import {
  type Facts,
  stateOf,
  type World,
  waitingOf,
} from "./conversation-state";

const facts = (f: Partial<Facts> = {}): Facts => ({
  busy: false,
  due: false,
  failed: false,
  for_credits: false,
  id: "c",
  imported: false,
  mac_held: false,
  open: false,
  reason: null,
  sent: false,
  stalled: false,
  state: "transcribed",
  summarized: false,
  words: false,
  ...f,
});
const world = (w: Partial<World> = {}): World => ({
  ai: true,
  creditsOut: false,
  macAble: true,
  recording: false,
  transcription: true,
  ...w,
});

test("state: words, then where its audio is", () => {
  expect(stateOf(facts({ busy: true, words: true }))).toBe("transcribing");
  expect(stateOf(facts({ summarized: true, words: true }))).toBe("summarized");
  expect(stateOf(facts({ words: true }))).toBe("transcribed");
  expect(stateOf(facts({ busy: true, sent: true }))).toBe("transcribing");
  expect(stateOf(facts({ busy: true }))).toBe("uploaded");
  expect(stateOf(facts({ failed: true }))).toBe("failed");
  expect(stateOf(facts())).toBe("transcribed");
});

test("waiting: its audio first, then the Mac's watermark, the phone, the summary", () => {
  const out = facts({ busy: true });
  expect(waitingOf(out, world({ transcription: false }))).toBe(
    "transcriptionOff"
  );
  expect(waitingOf(out, world({ creditsOut: true }))).toBe("creditsOut");
  // With the speech service, only a conversation with a block waiting for credits says so.
  expect(waitingOf({ ...out, for_credits: true }, world())).toBe("creditsOut");
  expect(waitingOf(out, world())).not.toBe("creditsOut");
  expect(waitingOf(out, world())).toBeNull();
  expect(waitingOf(facts({ mac_held: true }), world())).toBe("macAway");
  const quiet = facts({ open: true, stalled: true });
  expect(waitingOf(quiet, world({ recording: true }))).toBe("phoneQuiet");
  expect(waitingOf(quiet, world())).toBeNull();
  const due = facts({ due: true, words: true });
  expect(waitingOf(due, world({ ai: false }))).toBe("aiOff");
  expect(waitingOf(due, world({ macAble: false }))).toBe("macAway");
  expect(
    waitingOf(facts({ words: true }), world({ macAble: false }))
  ).toBeNull();
  expect(
    waitingOf(
      facts({ busy: true, imported: true }),
      world({ transcription: false })
    )
  ).toBeNull();
});
