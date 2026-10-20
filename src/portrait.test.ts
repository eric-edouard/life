import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORIGIN } from "./auth";
import { createPortrait } from "./portrait";

const dir = await mkdtemp(join(tmpdir(), "portrait-"));
const page = join(dir, "index.html");
await writeFile(page, "<h1>Someone, as Life knows him</h1>");
afterAll(() => rm(dir, { force: true, recursive: true }));

let clock = 1_800_000_000_000;
const portrait = createPortrait("open sesame", page, () => clock);

const get = async (cookie = "") =>
  (await portrait.handle(
    new Request(`${ORIGIN}/me`, { headers: { cookie } })
  )) as Response;
const login = async (password: string, origin = ORIGIN) =>
  (await portrait.handle(
    new Request(`${ORIGIN}/me`, {
      body: new URLSearchParams({ password }),
      headers: { origin },
      method: "POST",
    })
  )) as Response;
const session = (res: Response) =>
  (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

test("nothing of his before the password: the form, a wrong one 401, another site's post 403", async () => {
  const form = await get();
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
  const changed = createPortrait("new one", page, () => clock);
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

test("off without a password, and other paths are not its own", async () => {
  expect(
    await createPortrait("", page).handle(new Request(`${ORIGIN}/me`))
  ).toBeNull();
  expect(await portrait.handle(new Request(`${ORIGIN}/check/`))).toBeNull();
});
