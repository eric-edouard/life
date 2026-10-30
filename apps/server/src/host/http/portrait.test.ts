import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connector } from "../../core/settings";
import { createPortrait } from "./portrait";

const ORIGIN = connector().origin;

const dir = await mkdtemp(join(tmpdir(), "portrait-"));
await writeFile(join(dir, "index.html"), "<h1>Someone, as Life knows him</h1>");
await writeFile(join(dir, "sam.html"), "<h1>A friend</h1>");
await mkdir(join(dir, "sam", "clips"), { recursive: true });
await writeFile(join(dir, "sam", "clips", "hello.json"), '{"words":[]}');
await writeFile(join(dir, "sam", "clips", "hello.m4a"), "not really audio");
await writeFile(join(dir, "sam", "notes.md"), "research");
afterAll(() => rm(dir, { force: true, recursive: true }));

// Signed in is the cookie "in"; the check itself is sign-in.ts's.
const portrait = createPortrait(
  { app: null as never, signedIn: (r) => r.headers.get("cookie") === "in" },
  dir
);
const get = async (path: string, cookie = "") =>
  (await portrait.request(
    new Request(`${ORIGIN}${path}`, { headers: { cookie } })
  )) as Response;

test("nothing of his before sign-in: a page sends him to the app's sign-in and back, a clip is 401", async () => {
  const res = await get("/me/sam");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/sign-in?next=%2Fme%2Fsam");
  expect(await res.text()).not.toContain("A friend");
  expect((await get("/me/sam/clips/hello.m4a")).status).toBe(401);
});

test("signed in: /me is index.html, /me/<name> is <name>.html, nothing else", async () => {
  expect(await (await get("/me", "in")).text()).toContain("as Life knows him");
  const sam = await get("/me/sam", "in");
  expect(sam.headers.get("content-type")).toContain("text/html");
  expect(await sam.text()).toContain("A friend");
  expect((await get("/me/nobody", "in")).status).toBe(404);
  expect((await get("/me/..%2Fetc", "in")).status).toBe(404);
  expect((await get("/me/Sam.html", "in")).status).toBe(404);
  expect((await get("/me/sam/notes.md", "in")).status).toBe(404);
});

test("a page's clips and the player: typed, and the page's CSP allows them only", async () => {
  expect(
    (await get("/me/sam/clips/hello.m4a", "in")).headers.get("content-type")
  ).toBe("audio/x-m4a");
  expect(
    (await get("/me/sam/clips/hello.json", "in")).headers.get("content-type")
  ).toContain("application/json");
  const player = await get("/me/player.js", "in");
  expect(player.headers.get("content-type")).toContain("text/javascript");
  expect(await player.text()).toContain("figure.clip");
  expect(
    (await get("/me", "in")).headers.get("content-security-policy")
  ).toContain("media-src 'self'");
});

test("the decisions' old address goes to the web app's; other paths are not its own", async () => {
  const old = await get("/me/decisions");
  expect(old.status).toBe(302);
  expect(old.headers.get("location")).toBe("/decisions");
  expect((await get("/elsewhere", "in")).status).toBe(404);
});
