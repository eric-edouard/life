import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Update } from "./contract";
import { fakePiProvider } from "./fake-pi-provider";
import { type PiRow, piRowOf, piRuntime } from "./pi-runtime";

// The pi runtime over a real pi (the pinned one, run as the helper runs it) and a made-up provider that answers by the
// prompt's words: `[hang]` streams nothing until aborted, anything else gets "hello". One case per rule the desk leans on.

setDefaultTimeout(30_000);

const provider = fakePiProvider((_n, a) =>
  JSON.stringify(a.body.messages.at(-1)).includes("[hang]")
    ? "hang"
    : { text: "hello" }
);
const KEY = "OPENROUTER_API_KEY";
const kept = process.env[KEY];
beforeAll(() => {
  process.env[KEY] = "test-key";
});
afterAll(() => {
  provider.stop();
  process.env[KEY] = kept;
});

const dir = mkdtempSync(join(tmpdir(), "life-pi-runtime-"));
const row = piRowOf(false, {
  dir,
  provider: provider.providerOf({ only: ["host/fp8"], zdr: true }),
});
const agent: Agent = {
  door: { key: "door-key", url: `http://127.0.0.1:${provider.port}/door` },
  effort: null,
  folder: dir,
  id: "agt_made",
  model: null,
  title: "Made-up agent",
};

test("a first turn makes the session, ends with its usage, and the next turn resumes it", async () => {
  const pi = piRuntime(row);
  const first = await pi.start(agent, "Your brief.");
  await first.begun;
  expect(await first.ended).toEqual({
    ok: true,
    usage: {
      contextFirst: 12,
      contextLast: 12,
      tokensCached: 4,
      tokensIn: 6,
      tokensOut: 2,
    },
  });
  expect(await pi.state(first.ref)).toBe("idle");
  const before = provider.asked.length;
  const next = await pi.send(agent, first.ref, "A wake.");
  expect((await next.ended).ok).toBe(true);
  // The resumed session sends the first exchange back: the brief, its answer, then the wake.
  expect(provider.asked.slice(before)[0]?.body.messages.length).toBeGreaterThan(
    provider.asked[before - 1]?.body.messages.length ?? 0
  );
  expect(await pi.state("no-such-session")).toBe("gone");
});

test("talk keeps one pi across prompts and tells what its model says", async () => {
  const pi = piRuntime(row);
  const heard: Update[] = [];
  const one = await pi.talk(agent, null, "Hi.", (u) => heard.push(u));
  expect((await one.ended).ok).toBe(true);
  expect(heard).toContainEqual({ kind: "words", text: "hello" });
  expect(await pi.state(one.ref)).toBe("running");
  const two = await pi.talk(agent, null, "Again.", () => undefined);
  expect(two.ref).toBe(one.ref);
  expect((await two.ended).ok).toBe(true);
  await pi.stop(one.ref);
  expect(await pi.state(one.ref)).toBe("idle");
});

test("a stop ends a running turn as cancelled", async () => {
  const pi = piRuntime(row);
  const run = await pi.start(agent, "[hang]");
  await Bun.sleep(500);
  await pi.stop(run.ref);
  expect(await run.ended).toEqual({ ok: false, why: "cancelled" });
  await expect(run.begun).rejects.toThrow();
});

// Without the extension pi has no provider (it exits) and no guard; the open's own check (`PI_EXTENSION_COMMAND`)
// stands behind that for an extension that fails part way.
test("no turn runs on a pi whose Life extension did not load", async () => {
  const unguarded: PiRow = {
    ...row,
    async spawn(...args) {
      const s = await row.spawn(...args);
      const at = s.command.indexOf("-e");
      return {
        ...s,
        command: s.command.filter((_, i) => i !== at && i !== at + 1),
      };
    },
  };
  await expect(
    piRuntime(unguarded).start(agent, "Your brief.")
  ).rejects.toThrow();
});
