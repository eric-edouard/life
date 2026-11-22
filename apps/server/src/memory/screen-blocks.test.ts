import { expect, test } from "bun:test";
import { iso, MIN } from "../core/clock";
import type { SourceEvent } from "../records/source";
import { reconcile } from "./calendar-events";
import { SCREEN_OF, screenDrafts, screenLine } from "./screen-blocks";

const T0 = Date.parse("2026-10-09T10:00:00.000Z");
const stint = (
  device: string,
  from: number,
  until: number,
  text: string
): SourceEvent => ({
  at: iso(T0 + from * MIN),
  chat: device,
  chatName: device === "MAC" ? "Mac" : "Phone",
  fromMe: true,
  id: `screen:${device}/${from}`,
  sender: "me",
  source: "screen",
  text,
  until: iso(T0 + until * MIN),
});

const stints = [
  stint("MAC", 0, 30, "com.anthropic.claudefordesktop"),
  stint("MAC", 40, 50, "com.google.Chrome"),
  stint("MAC", 50, 55, "web: example.com"),
  stint("MAC", 55, 60, "com.google.Chrome"),
  stint("MAC", 62, 70, "com.example.Zed"),
  stint("MAC", 71, 72, "com.apple.dt.Xcode"),
  stint("MAC", 200, 230, "com.apple.dt.Xcode"),
  stint("PHONE", 10, 20, "com.apple.mobilesafari"),
];

test("stints under 15 minutes apart are one free block named by device and top apps", () => {
  const drafts = screenDrafts(stints);
  expect(drafts.map((d) => d.summary)).toEqual([
    "Mac · Claude, Chrome, Zed",
    "Mac · Xcode",
    "Phone · Safari",
  ]);
  const [first] = drafts;
  expect(first?.from).toBe(iso(T0));
  expect(first?.to).toBe(iso(T0 + 72 * MIN));
  expect(first?.of).toBe(`${SCREEN_OF}MAC/${iso(T0)}`);
  expect(first?.text).toContain("Claude 30 min");
  expect(first?.text).not.toContain("example.com");
});

test("a block that changed is updated and one that is the same is left alone", () => {
  const held = (d: { of: string; hash: string }[]) =>
    new Map(d.map((x, i) => [x.of, [{ hash: x.hash, id: `e${i}` }]]));
  const a = screenDrafts(stints);
  expect(reconcile(a, held(a)).create).toEqual([]);
  const more = screenDrafts([
    ...stints,
    stint("PHONE", 15, 25, "com.apple.MobileSMS"),
  ]);
  expect(reconcile(more, held(a)).update.map((u) => u.d.summary)).toEqual([
    "Phone · Safari, Messages",
  ]);
});

test("the nightly line gives each device's time in apps and its span", () => {
  const line = screenLine(stints);
  expect(line.startsWith("Mac 1 h 24 (")).toBe(true);
  expect(line).toContain("), Phone 10 min (");
  expect(screenLine([])).toBe("");
});
