import { expect, test } from "bun:test";
import type { Descriptor } from "../sources/contract";
import { failingParts, healthOf } from "./messaging-status";

const never = new Promise<string | undefined>(() => undefined);

test("a connector is ✗ when a part fails, the failures first; a send that never answers times out", async () => {
  const source = {
    kind: "chat",
    label: "Made-up",
    name: "radio",
    newest: () => ({ at: null }),
    send: { blocked: () => never, deliver: () => Promise.resolve() },
  } as unknown as Descriptor;
  const h = await healthOf({ label: "Made-up", source });
  expect(h).toEqual({
    detail: "not answering in 10 s",
    ok: false,
    parts: [{ kind: "send", ok: false, text: "not answering in 10 s" }],
  });
}, 15_000);

test("a connector whose send answers is ✓", async () => {
  const source = {
    kind: "chat",
    label: "Made-up",
    name: "radio",
    send: {
      blocked: () => Promise.resolve(undefined),
      deliver: () => Promise.resolve(),
    },
  } as unknown as Descriptor;
  expect((await healthOf({ label: "Made-up", source })).ok).toBe(true);
});

test("a card shows a stopped bridge, and a send it can't make only while sends are on; never its reading", () => {
  const health = {
    detail: "",
    ok: false,
    parts: [
      { kind: "bridge" as const, ok: false, text: "bridge stopped" },
      { kind: "read" as const, ok: false, text: "read failed" },
      { kind: "send" as const, ok: false, text: "not linked" },
    ],
  };
  expect(failingParts(health, true).map((p) => p.text)).toEqual([
    "bridge stopped",
    "not linked",
  ]);
  expect(failingParts(health, false).map((p) => p.text)).toEqual([
    "bridge stopped",
  ]);
  expect(failingParts(undefined, true)).toEqual([]);
});
