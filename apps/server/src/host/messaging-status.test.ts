import { expect, test } from "bun:test";
import type { Descriptor } from "../sources/contract";
import { healthOf } from "./messaging-status";

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
  expect(h).toEqual({ detail: "not answering in 10 s", ok: false });
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
