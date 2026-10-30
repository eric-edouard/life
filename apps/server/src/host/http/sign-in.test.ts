import { expect, test } from "bun:test";
import { DAY, HOUR } from "../../core/clock";
import { connector } from "../../core/settings";
import { createSignIn } from "./sign-in";

const ORIGIN = connector().origin;
let clock = 1_800_000_000_000;
const signIn = createSignIn("open sesame", () => clock);
if (!signIn) {
  throw new Error("a password makes a sign-in");
}

const login = async (password: string, origin = ORIGIN) =>
  (await signIn.app.request(
    new Request(`${ORIGIN}/api/sign-in`, {
      body: JSON.stringify({ password }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    })
  )) as Response;
const session = (res: Response) =>
  (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const isIn = (cookie: string, s = signIn) =>
  s.signedIn(new Request(ORIGIN, { headers: { cookie } }));

test("a wrong password 401, another site's post 403, a forged cookie is no one", async () => {
  expect((await login("nope")).status).toBe(401);
  expect((await login("open sesame", "https://elsewhere.example")).status).toBe(
    403
  );
  expect(isIn("__Host-life-me=9999999999.forged")).toBe(false);
});

test("the right password gives a cookie that holds until it expires", async () => {
  const res = await login("open sesame");
  expect(res.status).toBe(200);
  const cookie = session(res);
  expect(isIn(cookie)).toBe(true);
  clock += 31 * DAY;
  expect(isIn(cookie)).toBe(false);
});

test("a new password signs every browser out", async () => {
  const cookie = session(await login("open sesame"));
  const changed = createSignIn("new one", () => clock);
  expect(changed && isIn(cookie, changed)).toBe(false);
});

test("five wrong tries a minute, then even the right password waits", async () => {
  clock += HOUR;
  await Promise.all(Array.from({ length: 5 }, () => login("nope")));
  expect((await login("open sesame")).status).toBe(429);
  clock += 61_000;
  expect((await login("open sesame")).status).toBe(200);
});

test("a burst of wrong guesses can't slip the right one through", async () => {
  clock += HOUR;
  const burst = await Promise.all([
    ...Array.from({ length: 20 }, () => login("nope")),
    login("open sesame"),
  ]);
  expect(burst.at(-1)?.status).toBe(429);
});

test("off without a password", () => {
  expect(createSignIn("")).toBeNull();
});
