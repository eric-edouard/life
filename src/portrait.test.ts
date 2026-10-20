import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORIGIN } from "./auth";
import { createPortrait } from "./portrait";

const dir = await mkdtemp(join(tmpdir(), "portrait-"));
await writeFile(join(dir, "index.html"), "<h1>Someone, as Life knows him</h1>");
await writeFile(join(dir, "sam.html"), "<h1>A friend</h1>");
await mkdir(join(dir, "sam", "clips"), { recursive: true });
await writeFile(join(dir, "sam", "clips", "hello.json"), '{"words":[]}');
await writeFile(join(dir, "sam", "clips", "hello.m4a"), "not really audio");
await writeFile(join(dir, "sam", "research.json"), "{}");
await writeFile(join(dir, "sam", "notes.md"), "research");
afterAll(() => rm(dir, { force: true, recursive: true }));

let clock = 1_800_000_000_000;
const portrait = createPortrait("open sesame", dir, () => clock);

const get = async (cookie = "", path = "/me") =>
  (await portrait.handle(
    new Request(`${ORIGIN}${path}`, { headers: { cookie } })
  )) as Response;
const login = async (password: string, origin = ORIGIN, path = "/me") =>
  (await portrait.handle(
    new Request(`${ORIGIN}${path}`, {
      body: new URLSearchParams({ password }),
      headers: { origin },
      method: "POST",
    })
  )) as Response;
const session = (res: Response) =>
  (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

test("nothing of his before the password: the form, a wrong one 401, another site's post 403", async () => {
  const form = await get();
  // A browser only sends our Origin with the form's post when the form page allows a same-origin referrer.
  expect(form.headers.get("referrer-policy")).toBe("same-origin");
  expect(await form.text()).not.toContain("as Life knows him");
  expect((await login("nope")).status).toBe(401);
  expect((await login("open sesame", "https://elsewhere.example")).status).toBe(
    403
  );
  expect(
    await (await get("__Host-life-me=9999999999.forged")).text()
  ).toContain('type="password"');
});

test("the right password gives a cookie that opens the page until it expires", async () => {
  const res = await login("open sesame");
  expect(res.status).toBe(302);
  const cookie = session(res);
  expect(await (await get(cookie)).text()).toContain("as Life knows him");
  clock += 31 * 24 * 3600 * 1000;
  expect(await (await get(cookie)).text()).toContain('type="password"');
});

test("a new password signs every browser out", async () => {
  const cookie = session(await login("open sesame"));
  const changed = createPortrait("new one", dir, () => clock);
  const res = (await changed.handle(
    new Request(`${ORIGIN}/me`, { headers: { cookie } })
  )) as Response;
  expect(await res.text()).toContain('type="password"');
});

test("five wrong tries a minute, then even the right password waits", async () => {
  clock += 3_600_000;
  await Promise.all(Array.from({ length: 5 }, () => login("nope")));
  expect((await login("open sesame")).status).toBe(429);
  clock += 61_000;
  expect((await login("open sesame")).status).toBe(302);
});

test("a burst of wrong guesses can't slip the right one through", async () => {
  clock += 3_600_000;
  const burst = await Promise.all([
    ...Array.from({ length: 20 }, () => login("nope")),
    login("open sesame"),
  ]);
  expect(burst.at(-1)?.status).toBe(429);
});

test("a person's page: the form keeps its path through sign-in, then /me/<name> serves <name>.html", async () => {
  clock += 3_600_000;
  expect(await (await get("", "/me/sam")).text()).toContain('action="/me/sam"');
  const res = await login("open sesame", ORIGIN, "/me/sam");
  expect(res.headers.get("location")).toBe("/me/sam");
  const cookie = session(res);
  expect(await (await get(cookie, "/me/sam")).text()).toContain("A friend");
  expect((await get(cookie, "/me/nobody")).status).toBe(404);
  expect(
    await portrait.handle(new Request(`${ORIGIN}/me/..%2Fetc`))
  ).toBeNull();
  expect(await (await login("nope", ORIGIN, "/me/sam")).text()).toContain(
    'action="/me/sam"'
  );
  expect(
    await portrait.handle(new Request(`${ORIGIN}/me/Sam.html`))
  ).toBeNull();
});

test("a page's clips and the player: behind the password, typed, and nothing outside clips/", async () => {
  clock += 3_600_000;
  expect((await get("", "/me/sam/clips/hello.m4a")).status).toBe(401);
  const cookie = session(await login("open sesame"));
  const audio = await get(cookie, "/me/sam/clips/hello.m4a");
  expect(audio.headers.get("content-type")).toBe("audio/x-m4a");
  expect(
    (await get(cookie, "/me/sam/clips/hello.json")).headers.get("content-type")
  ).toContain("application/json");
  const player = await get(cookie, "/me/player.js");
  expect(player.headers.get("content-type")).toContain("text/javascript");
  expect(await player.text()).toContain("figure.clip");
  expect(
    await portrait.handle(new Request(`${ORIGIN}/me/sam/notes.md`))
  ).toBeNull();
  expect(
    (await get(cookie, "/me")).headers.get("content-security-policy")
  ).toContain("media-src 'self'");
});

test("off without a password, and other paths are not its own", async () => {
  expect(
    await createPortrait("", dir).handle(new Request(`${ORIGIN}/me`))
  ).toBeNull();
  expect(await portrait.handle(new Request(`${ORIGIN}/check/`))).toBeNull();
});
