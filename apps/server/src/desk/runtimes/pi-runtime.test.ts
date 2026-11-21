import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Update } from "./contract";
import { fakePiProvider } from "./fake-pi-provider";
import { type PiRow, piRowOf, piRuntime } from "./pi-runtime";

// The pi runtime over a real pi (the pinned one, run as the helper runs it) and a made-up provider that answers by the
// prompt's words: `[hang]` streams nothing until aborted, `[sep]` an answer holding U+2028, anything else "hello". One
// case per rule the desk leans on.

setDefaultTimeout(30_000);

const provider = fakePiProvider((_n, a) =>
  JSON.stringify(a.body.messages.at(-1)).includes("[hang]")
    ? "hang"
    : {
        text: JSON.stringify(a.body.messages.at(-1)).includes("[sep]")
          ? "one\u2028two"
          : "hello",
      }
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

test("an answer holding a line separator is heard whole", async () => {
  const heard: Update[] = [];
  const run = await piRuntime(row).talk(agent, null, "[sep]", (u) =>
    heard.push(u)
  );
  expect(await run.ended).toMatchObject({ ok: true, usage: { tokensOut: 2 } });
  expect(heard).toContainEqual({ kind: "words", text: "one\u2028two" });
});

test("a session another process keeps reads as running, and is never sent beside it", async () => {
  const keeper = piRuntime(row);
  const kept = await keeper.talk(agent, null, "Hi.", () => undefined);
  await kept.ended;
  const other = piRuntime(row);
  expect(await other.state(kept.ref)).toBe("running");
  await expect(other.send(agent, kept.ref, "A wake.")).rejects.toThrow();
  await keeper.stop(kept.ref);
  expect(await other.state(kept.ref)).toBe("idle");
});

test("a prompt pi takes as a command ends its turn at once", async () => {
  const run = await piRuntime(row).start(agent, "/life-desk");
  expect(await run.ended).toEqual({
    ok: false,
    why: "pi handled the prompt as a command",
  });
});

test("pi runs its one model by the desk's word, and refuses another", async () => {
  const pi = piRuntime(row);
  expect(
    (await (await pi.start({ ...agent, model: "flash" }, "Hi.")).ended).ok
  ).toBe(true);
  await expect(pi.start({ ...agent, model: "opus" }, "Hi.")).rejects.toThrow(
    "one model"
  );
});
