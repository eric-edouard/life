import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connector } from "../../core/settings";
import { decisionsNow, writeDecision } from "../../memory/decisions";
import { DECISIONS } from "../../memory/ledger";
import { createWeb } from "./web";

const ORIGIN = connector().origin;
const dist = await mkdtemp(join(tmpdir(), "web-"));
await mkdir(join(dist, "app"));
await writeFile(join(dist, "index.html"), "<div id=root></div>");
await writeFile(join(dist, "app", "index-Ab12.js"), "console.log(1)");
afterAll(() => rm(dist, { force: true, recursive: true }));

const signIn = {
  app: new (await import("hono")).Hono(),
  signedIn: (r: Request) => r.headers.get("cookie") === "in",
};
const web = createWeb(signIn, Date.now, dist);
const get = async (path: string, headers: Record<string, string> = {}) =>
  (await web.request(new Request(`${ORIGIN}${path}`, { headers }))) as Response;
const post = (body: object, origin = ORIGIN, cookie = "in") =>
  web.request(
    new Request(`${ORIGIN}/api/decisions`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", cookie, origin },
      method: "POST",
    })
  ) as Promise<Response>;
const HTML = { accept: "text/html,*/*" };

test("the app is code, served to anyone asking for a page; its data only after sign-in", async () => {
  const page = await get("/decisions", HTML);
  expect(await page.text()).toContain("id=root");
  expect(page.headers.get("content-security-policy")).toContain(
    "default-src 'self'"
  );
  expect((await get("/sign-in?next=%2Fdecisions", HTML)).status).toBe(200);
  expect((await get("/api/decisions")).status).toBe(401);
  expect((await post({}, ORIGIN, ""))?.status).toBe(401);
  const built = await get("/app/index-Ab12.js");
  expect(built.headers.get("cache-control")).toContain("immutable");
});

test("the catch-all never answers what isn't a page: API paths, OAuth probes, files, other requests", async () => {
  expect((await get("/api/nothing", { ...HTML, cookie: "in" })).status).toBe(
    404
  );
  expect(
    (await get("/.well-known/oauth-protected-resource/x", HTML)).status
  ).toBe(404);
  expect((await get("/decisions")).status).toBe(404);
  expect((await get("/app/..%2F..%2Fsecret.js")).status).toBe(404);
  expect((await get("/app/missing-Zz.js")).status).toBe(404);
});

test("his decisions: his tap lands; another site's post, a tap on a taken one and a step that isn't his are refused", async () => {
  await rm(DECISIONS, { force: true });
  const id = "asks-20261029100000-1";
  writeDecision([
    {
      data: {
        loop: "asks",
        options: [{ id: "send", label: "Send it" }],
        question: "Send the reply?",
      },
      decision: id,
      step: "asked",
    },
  ]);
  expect(
    (await (await get("/api/decisions", { cookie: "in" })).json())[0]
  ).toMatchObject({ id, status: "open" });
  const tap = {
    data: { answer: "send", note: "" },
    decision: id,
    step: "answered",
  };
  expect((await post(tap, "https://elsewhere.example")).status).toBe(403);
  expect((await post(tap)).status).toBe(200);
  writeDecision([{ decision: id, step: "taken" }]);
  expect(
    (
      await post({
        data: { answer: null, note: "" },
        decision: id,
        step: "answered",
      })
    ).status
  ).toBe(409);
  expect(
    (
      await post({
        data: { loop: "asks", note: "the plumber reply was wrong", ref: id },
        step: "asked",
      })
    ).status
  ).toBe(200);
  expect(
    [...decisionsNow().values()].find((d) => d.kind === "audit")
  ).toMatchObject({
    context: "the plumber reply was wrong",
    options: [],
    ref: id,
    status: "open",
  });
  expect((await post({ decision: id, step: "done" })).status).toBe(400);
  await rm(DECISIONS, { force: true });
});
