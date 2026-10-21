import { expect, test } from "bun:test";
import { createDashboard } from "./dashboard";
import { createSignIn } from "./signin";

// The status page answers nothing of his before the owner's sign-in: a page sends him to sign in, a read is refused.
const verify = async (token: string) =>
  token === "owner"
    ? { clientId: "c", scopes: ["life:read"] }
    : { refusal: "invalid" as const, why: "no token" };
const signIn = createSignIn(
  verify,
  (async () => new Response("no", { status: 400 })) as unknown as typeof fetch
);
const page = createDashboard(signIn);
const get = (path: string) =>
  page.handle(new Request(`https://life.example${path}`));

test("without the owner's session the page sends him to sign in and every read is refused", async () => {
  const root = await get("/");
  expect(root?.status).toBe(302);
  expect(root?.headers.get("location")).toContain("/oauth2/authorize");
  const reads = [
    "/status/snapshot",
    "/status/stream",
    "/status/card/nightly",
    "/status/run?id=x",
  ];
  const answers = await Promise.all(reads.map(get));
  expect(answers.map((a) => a?.status)).toEqual([401, 401, 401, 401]);
  expect(await get("/mcp")).toBeNull();
});

test("a sign-in lands only on one of his pages", () => {
  const landing = (next: string) =>
    decodeURIComponent(
      signIn.login(next).headers.get("set-cookie")?.split(";")[0] ?? ""
    )
      .split(".")
      .at(-1);
  expect(landing("/")).toBe("/");
  expect(landing("/check/")).toBe("/check/");
  expect(landing("https://evil.example/")).toBe("/check/");
});

test("a history that doesn't page back offers no older page: the tasks and the Mac's day are whole", async () => {
  const { detail } = await import("./plate-detail");
  expect((await detail("tasks")).next.history).toBeNull();
});
