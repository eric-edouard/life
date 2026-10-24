import { expect, test } from "bun:test";
import { parseTranscript, textOf, verifySignature } from "./elevenlabs";
import { providerTranscript, signature, WEBHOOK_SECRET } from "./testing";

test("transcript parses into timed words and speaker turns", () => {
  const { transcript, transcriptionId } = parseTranscript(providerTranscript);
  expect(transcriptionId).toBe("tr_1");
  expect(transcript.languageCode).toBe("eng");
  expect(transcript.words.map((w) => w.text)).toEqual([
    "Hello",
    "there.",
    "Bonjour!",
  ]);
  expect(transcript.words[0]).toEqual({
    end: 0.4,
    logprob: -0.1,
    spacing: "",
    speakerId: "speaker_0",
    start: 0,
    text: "Hello",
  });
  expect(transcript.turns).toEqual([
    { end: 0.9, speakerId: "speaker_0", start: 0, text: "Hello there." },
    { end: 2, speakerId: "speaker_1", start: 1.5, text: "Bonjour!" },
  ]);
});

test("a pause of more than 2 s starts a new turn for the same speaker", () => {
  const word = (text: string, start: number, end: number) => ({
    end,
    speaker_id: "speaker_0",
    start,
    text,
    type: "word",
  });
  const { transcript } = parseTranscript({
    ...providerTranscript,
    words: [
      word("One", 0, 0.5),
      { text: " ", type: "spacing" },
      word("two", 2.5, 3),
      { text: " ", type: "spacing" },
      word("three", 5.1, 5.5),
    ],
  });
  expect(transcript.turns.map((t) => [t.start, t.end, t.text])).toEqual([
    [0, 3, "One two"],
    [5.1, 5.5, "three"],
  ]);
});

test("Thai keeps the provider's spacing: none between letters, its own between phrases", () => {
  // Real Scribe tokens, one per letter cluster ("four days? oh, hello"), times shifted.
  const tokens = "สี่|วั|น|เ|ล|ย|เ|ห|ร|อ|ค|รั|บ| |อ๋|อ| |ส|วั|ส|ดี|ค|รั|บ"
    .split("|")
    .map((text, i) =>
      text === " "
        ? { text, type: "spacing" }
        : {
            end: i / 10 + 0.1,
            speaker_id: "speaker_1",
            start: i / 10,
            text,
            type: "word",
          }
    );
  const { transcript } = parseTranscript({
    ...providerTranscript,
    words: tokens,
  });
  const said = "สี่วันเลยเหรอครับ อ๋อ สวัสดีครับ";
  expect(transcript.turns.map((t) => t.text)).toEqual([said]);
  // Only the words after a provider space carry one.
  expect(transcript.words.filter((w) => w.spacing).map((w) => w.text)).toEqual([
    "อ๋",
    "ส",
  ]);
  expect(textOf(transcript.words)).toBe(said);
});

test("a pause inside a Thai word keeps the turn; a pause before a space splits it", () => {
  const letter = (text: string, start: number) => ({
    end: start + 0.1,
    speaker_id: "speaker_0",
    start,
    text,
    type: "word",
  });
  // "ได้เงิน" with a 3 s gap after its first letter (as heard at a café till), then " ครับ" 3 s later.
  const { transcript } = parseTranscript({
    ...providerTranscript,
    words: [
      letter("ไ", 0),
      letter("ด้", 3),
      letter("เ", 3.2),
      letter("งิ", 3.3),
      letter("น", 3.4),
      { text: " ", type: "spacing" },
      letter("ค", 6.6),
      letter("รั", 6.7),
      letter("บ", 6.8),
    ],
  });
  expect(transcript.turns.map((t) => t.text)).toEqual(["ได้เงิน", "ครับ"]);
});

test("webhook signature: valid, tampered, wrong secret, stale, malformed", () => {
  const body = '{"type":"speech_to_text_transcription"}';
  const now = 1_800_000_000;
  const valid = signature(body, now);
  expect(verifySignature(valid, body, WEBHOOK_SECRET, now)).toBe(true);
  expect(verifySignature(valid, `${body} `, WEBHOOK_SECRET, now)).toBe(false);
  expect(verifySignature(valid, body, "other-secret", now)).toBe(false);
  expect(verifySignature(valid, body, WEBHOOK_SECRET, now + 31 * 60)).toBe(
    false
  );
  expect(verifySignature(valid, body, WEBHOOK_SECRET, now + 29 * 60)).toBe(
    true
  );
  expect(verifySignature(undefined, body, WEBHOOK_SECRET, now)).toBe(false);
  expect(verifySignature(`t=${now},v0=zz`, body, WEBHOOK_SECRET, now)).toBe(
    false
  );
});
