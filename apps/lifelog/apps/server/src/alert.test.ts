// The owner's alert email (alert.ts): sent only with a key, a sender and an address, from the sender configured.
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { emailOwner } from "./alert";
import { testConfig } from "./testing";

const sent = spyOn(globalThis, "fetch").mockResolvedValue(
  new Response(null, { status: 200 })
);
afterEach(() => sent.mockClear());
// Every test file shares this process's fetch.
afterAll(() => sent.mockRestore());

const alert = { key: "k1", subject: "s", text: "t" };
const configured = {
  ALERT_EMAIL_FROM: "Lifelog <alerts@example.com>",
  ALERT_EMAIL_TO: "owner@example.com",
  RESEND_API_KEY: "re_test",
};

test("no alert without a key, a sender or an address", async () => {
  for (const missing of Object.keys(configured)) {
    const config = testConfig("http://localhost:1", {
      ...configured,
      [missing]: undefined,
    });
    // biome-ignore lint/performance/noAwaitInLoops: one case at a time
    expect(await emailOwner(config, alert)).toBeNull();
  }
  expect(sent).not.toHaveBeenCalled();
});

test("an alert goes from the configured sender", async () => {
  const config = testConfig("http://localhost:1", configured);
  expect(await emailOwner(config, alert)).toBe(200);
  const [, init] = sent.mock.calls[0] ?? [];
  expect(JSON.parse(String(init?.body))).toMatchObject({
    from: "Lifelog <alerts@example.com>",
    to: ["owner@example.com"],
  });
});
