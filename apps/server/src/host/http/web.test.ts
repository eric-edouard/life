import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl } from "../../core/files";
import { connector } from "../../core/settings";
import { decisionsNow, writeDecision } from "../../memory/decisions";
import { factCheckAsk } from "../../memory/fact-checks";
import {
  DECISIONS,
  RATINGS,
  readRatings,
  readStatements,
  STATEMENTS,
} from "../../memory/ledger";
import { Statement } from "../../records/statement";
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

test("his decisions: his tap lands and is recorded as the rating; another site's post, a tap on a done one and a step that isn't his are refused", async () => {
  const fresh = () =>
    Promise.all(
      [DECISIONS, RATINGS, STATEMENTS].map((f) => rm(f, { force: true }))
    );
  await fresh();
  const ref = "obs_000000000001";
  appendJsonl(STATEMENTS, Statement, [
    {
      at: "2026-10-29T10:00:00.000Z",
      date: "2026-10-28",
      group: "events",
      kind: "fact",
      ref,
      schemaVersion: 1,
      source: "whatsapp",
      text: "Zoé runs the bakery.",
      units: ["unit_000000000000"],
    },
  ]);
  const id = "fact-checks-20261029100000-1";
  writeDecision([
    {
      data: factCheckAsk(
        { ...readStatements()[0], ref } as Parameters<typeof factCheckAsk>[0],
        []
      ),
      decision: id,
      step: "asked",
    },
  ]);
  expect(
    (await (await get("/api/decisions", { cookie: "in" })).json())[0]
  ).toMatchObject({ id, status: "open" });
  const tap = {
    data: { answer: "false", note: "she sold it" },
    decision: id,
    step: "answered",
  };
  expect((await post(tap, "https://elsewhere.example")).status).toBe(403);
  expect((await post(tap)).status).toBe(200);
  expect(decisionsNow().get(id)?.status).toBe("done");
  expect(readRatings().get(ref)?.answer).toBe("false");
  expect((await post(tap)).status).toBe(409);
  expect((await post({ decision: id, step: "done" })).status).toBe(400);
  await fresh();
});
