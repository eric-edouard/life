import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGES, blockOf, bridgeSend, linkBridge } from "./matrix";

test("a bridge that isn't set up or running is a reason the send is blocked, never a throw", async () => {
  expect(await bridgeSend("nowhere").blocked()).toContain(
    "nowhere bridge not answering"
  );
});

test("a bridge blocks sends only when never linked or in a state it won't leave by itself", () => {
  expect(blockOf("whatsapp", [])).toContain("not linked");
  expect(
    blockOf("whatsapp", [{ state: { state_event: "CONNECTED" } }])
  ).toBeUndefined();
  expect(
    blockOf("whatsapp", [{ state: { state_event: "TRANSIENT_DISCONNECT" } }])
  ).toBeUndefined();
  expect(
    blockOf("whatsapp", [
      {
        state: {
          message: "logged out on the phone",
          state_event: "BAD_CREDENTIALS",
        },
      },
    ])
  ).toBe("whatsapp bridge BAD_CREDENTIALS: logged out on the phone");
});

test("a login goes step by step: his answers to each field, a code shown, until it's linked", async () => {
  const seen: { body: string; path: string }[] = [];
  const steps = [
    {
      login_id: "L",
      step_id: "s1",
      type: "user_input",
      user_input: {
        fields: [
          { id: "email", name: "Email" },
          { id: "password", type: "password" },
        ],
      },
    },
    {
      display_and_wait: { data: "123-456", type: "code" },
      login_id: "L",
      step_id: "s2",
      type: "display_and_wait",
    },
    {
      complete: { user_login_id: "u1" },
      login_id: "L",
      step_id: "s3",
      type: "complete",
    },
  ];
  const server = Bun.serve({
    async fetch(req) {
      seen.push({ body: await req.text(), path: new URL(req.url).pathname });
      return Response.json(steps[seen.length - 1]);
    },
    port: 0,
  });
  const dir = join(BRIDGES, "testnet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.yaml"),
    `appservice:\n  port: ${server.port}\nprovisioning:\n  shared_secret: s3cret\n`
  );
  const shown: string[] = [];
  try {
    const id = await linkBridge("testnet", "password", {
      show: (s) => shown.push(s.display_and_wait?.data ?? s.type),
      value: (f) => (f.hidden ? `secret-${f.id}` : `given-${f.id}`),
    });
    expect(id).toBe("u1");
  } finally {
    server.stop();
  }
  expect(seen.map((s) => s.path)).toEqual([
    "/_matrix/provision/v3/login/start/password",
    "/_matrix/provision/v3/login/step/L/s1/user_input",
    "/_matrix/provision/v3/login/step/L/s2/display_and_wait",
  ]);
  expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({
    email: "given-email",
    password: "secret-password",
  });
  expect(shown).toEqual(["user_input", "123-456"]);
});
