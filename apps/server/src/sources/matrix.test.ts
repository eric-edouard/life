import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIDGES,
  blockOf,
  cookieValues,
  linkBridge,
  pastedValues,
  readBlock,
} from "./matrix";

test("a bridge that isn't set up or running is a reason it is blocked, never a throw", async () => {
  expect(await readBlock("nowhere")).toContain("nowhere bridge not answering");
});

test("a bridge is blocked only when never linked or in a state it won't leave by itself", () => {
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
      cookies: () => Promise.resolve(new Map()),
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

test("one pasted request fills every cookie: from its Cookie header, -b, or a header source; JSON works too", () => {
  const fields = [
    {
      id: "li_at",
      required: true,
      sources: [{ name: "li_at", type: "cookie" }],
    },
    {
      id: "JSESSIONID",
      required: true,
      sources: [{ name: "JSESSIONID", type: "cookie" }],
    },
    { id: "csrf", sources: [{ name: "csrf-token", type: "request_header" }] },
    { id: "shbid" },
  ];
  const curl = `curl 'https://www.linkedin.com/feed/' -H 'Cookie: li_at=AQE=x; JSESSIONID="ajax:1"' -H 'csrf-token: ajax:1'`;
  // LinkedIn's bridge wants the whole Cookie header, from a request to it.
  expect(
    cookieValues(
      [{ id: "h", sources: [{ name: "Cookie", type: "request_header" }] }],
      pastedValues(curl)
    ).get("h")
  ).toBe('li_at=AQE=x; JSESSIONID="ajax:1"');
  expect(Object.fromEntries(cookieValues(fields, pastedValues(curl)))).toEqual({
    csrf: "ajax:1",
    JSESSIONID: '"ajax:1"',
    li_at: "AQE=x",
  });
  expect(
    Object.fromEntries(
      cookieValues(fields, pastedValues(`curl x -b 'li_at=a; JSESSIONID=b'`))
    )
  ).toEqual({ JSESSIONID: "b", li_at: "a" });
  expect(
    Object.fromEntries(cookieValues(fields, pastedValues('{"li_at":"a"}')))
  ).toEqual({ li_at: "a" });
});

test("a request copied as cURL over several lines, with $'…' quoting, still gives its cookies and headers", () => {
  const copied = String.raw`curl 'https://www.linkedin.com/voyager/api/me' \
  -H 'accept: application/json' \
  -b $'li_at=AQ\u0021x; JSESSIONID="ajax:1"; it\'s=ok' \
  -H $'x-li-track: {"clientVersion":"1.2"}'`;
  const p = pastedValues(copied);
  expect(p.cookies.get("li_at")).toBe("AQ!x");
  expect(p.cookies.get("it's")).toBe("ok");
  expect(p.headers.get("x-li-track")).toBe('{"clientVersion":"1.2"}');
  expect(p.headers.get("accept")).toBe("application/json");
});
