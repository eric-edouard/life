import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { linesOf } from "../../core/files";
import { LOG_DIR } from "../../core/log";
import { readSettings, setSettings } from "../../core/settings";
import { BRIDGES } from "../../sources/matrix";
import { HOLD } from "../network-sign-in";
import { rpc, token } from "./mcp-test-harness";
import { expectWire } from "./wire-fixture";

// `sign_in_to_network` against a made-up LINE bridge: his token only, never a network that works, one step per call,
// a display step's wait held across his app switch, and his answers never in the log or a refusal.

const PASSWORD = "made-up-pw-7731";
const seen: { body: string; path: string }[] = [];
let state = "LOGGED_OUT";
let refuseStep = false;
let release: (() => void) | undefined;

const bridge = Bun.serve({
  async fetch(req) {
    const path = new URL(req.url).pathname.replace(
      "/_matrix/provision/v3/",
      ""
    );
    seen.push({ body: await req.text(), path });
    if (path === "whoami") {
      return Response.json({ logins: [{ state: { state_event: state } }] });
    }
    if (path.startsWith("login/start/")) {
      return Response.json({
        instructions: "Sign in with your LINE email.",
        login_id: "L1",
        step_id: "s1",
        type: "user_input",
        unknown_to_the_phone: "dropped",
        user_input: {
          fields: [
            { id: "email", name: "Email", type: "email" },
            { id: "password", name: "Password", type: "password" },
          ],
        },
      });
    }
    if (path === "login/step/L1/s1/user_input") {
      return refuseStep
        ? Response.json({ error: `bad password ${PASSWORD}` }, { status: 400 })
        : Response.json({
            display_and_wait: { data: "482913", type: "code" },
            instructions: "Enter this PIN in LINE.",
            login_id: "L1",
            step_id: "s2",
            type: "display_and_wait",
          });
    }
    // The PIN step answers once he typed it in LINE: here, once the test lets it.
    await new Promise<void>((done) => {
      release = done;
    });
    return Response.json({
      complete: { user_login_id: "u1" },
      login_id: "L1",
      step_id: "s3",
      type: "complete",
    });
  },
  port: 0,
});

const dir = join(BRIDGES, "line");
const config = join(dir, "config.yaml");
const kept = existsSync(config) ? readFileSync(config, "utf8") : undefined;
const sources = readSettings().sources;
const hold = { ...HOLD };

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    config,
    `appservice:\n  port: ${bridge.port}\nprovisioning:\n  shared_secret: s3cret\n`
  );
  setSettings({ sources: sources.filter((s) => s !== "line") });
  HOLD.ms = 100;
});

afterAll(() => {
  bridge.stop(true);
  if (kept === undefined) {
    rmSync(config);
  } else {
    writeFileSync(config, kept);
  }
  setSettings({ sources });
  Object.assign(HOLD, hold);
});

const call = async (args: object, over: Record<string, unknown> = {}) =>
  (
    await rpc(await token({ agent: undefined, ...over }), "tools/call", {
      arguments: args,
      name: "sign_in_to_network",
    })
  ).json.result as { content: { text: string }[]; isError: boolean };
const json = (r: { content: { text: string }[] }) =>
  JSON.parse(r.content[0]?.text ?? "");

test("an agent's token is refused, before any call to the bridge", async () => {
  const before = seen.length;
  const r = await call({ network: "line" }, { agent: "Orbit" });
  expect(r.isError).toBe(true);
  expect(r.content[0]?.text).toContain("paired as an agent");
  expect(seen.length).toBe(before);
});

test("a network whose login works is never signed in again: no account swapped", async () => {
  state = "CONNECTED";
  const r = await call({ network: "line" });
  state = "LOGGED_OUT";
  expect(r.content[0]?.text).toBe("Not done: LINE is signed in already.");
  expect(seen.some((s) => s.path.startsWith("login/"))).toBe(false);
});

test("a refused step says so in his words, never with what he typed, and logs nothing of it", async () => {
  refuseStep = true;
  const r = await call({
    answers: { email: "mia@example.com", password: PASSWORD },
    loginId: "L1",
    network: "line",
    stepId: "s1",
    type: "user_input",
  });
  refuseStep = false;
  expect(r.content[0]?.text).toBe(
    "Not done: LINE didn't accept that. Try again."
  );
});

test("signed out: its loginFlow starts, each step trimmed for the phone, the PIN's wait held across his app switch, then done", async () => {
  const first = json(await call({ network: "line" }));
  expect(seen.at(-1)?.path).toBe(
    "login/start/dev.highest.matrix.line.email_login"
  );
  expect(first).toEqual({
    status: "step",
    step: {
      fields: [
        { id: "email", name: "Email", type: "email" },
        { id: "password", name: "Password", type: "password" },
      ],
      instructions: "Sign in with your LINE email.",
      loginId: "L1",
      stepId: "s1",
      type: "user_input",
    },
  });
  const pin = json(
    await call({
      answers: { email: "mia@example.com", password: PASSWORD },
      loginId: "L1",
      network: "line",
      stepId: "s1",
      type: "user_input",
    })
  );
  expect(JSON.parse(seen.at(-1)?.body ?? "")).toEqual({
    email: "mia@example.com",
    password: PASSWORD,
  });
  expect(pin.step).toMatchObject({
    display: { data: "482913", type: "code" },
    type: "display_and_wait",
  });
  const step = {
    loginId: "L1",
    network: "line",
    stepId: "s2",
    type: "display_and_wait",
  };
  // He is in LINE: the request is answered `waiting`; asked again, the same wait (one call to the bridge).
  expect(json(await call(step))).toEqual({
    loginId: "L1",
    status: "waiting",
    stepId: "s2",
  });
  expect(json(await call(step)).status).toBe("waiting");
  expect(
    seen.filter((s) => s.path === "login/step/L1/s2/display_and_wait").length
  ).toBe(1);
  release?.();
  // Linked while he was away: its source is on before he asks again.
  await Bun.sleep(50);
  expect(readSettings().sources).toContain("line");
  const done = json(await call(step));
  expect(done).toEqual({ network: "line", status: "done" });
  // What PR 2's sheet decodes (Kit's tests read the same file).
  expectWire("sign_in_to_network", [
    first,
    pin,
    { loginId: "L1", status: "waiting", stepId: "s2" },
    done,
  ]);
});

test("the log keeps the calls' argument names, never his answers", () => {
  const lines = linesOf(
    join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`)
  ).filter((l) => l.includes("sign_in_to_network"));
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) {
    expect(l).not.toContain(PASSWORD);
    expect(l).not.toContain("mia@example.com");
  }
  expect(JSON.parse(lines.at(-1) ?? "{}").args).toEqual([
    "loginId",
    "network",
    "stepId",
    "type",
  ]);
});
