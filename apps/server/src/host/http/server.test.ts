import { expect, test } from "bun:test";
import { signedIn } from "./server";

// The public port's app as served, its parts mounted in order: nothing of his before a sign-in, and no route but theirs.
test("the public port refuses the owner's pages without a session, serves Life's brand to anyone, and answers 404 for anything else", async () => {
  const app = signedIn();
  const get = (path: string, init?: RequestInit) =>
    app.request(`https://life.example.test${path}`, init);
  expect([200, 204]).not.toContain((await get("/check/statements")).status);
  expect((await get("/mcp")).status).toBe(401);
  expect((await get("/auth/oauth2/token")).status).toBe(404);
  expect((await get("/me/..%2Fetc")).status).toBe(404);
  const css = await get("/assets/brand/tokens.css");
  expect([css.status, (await css.text()).includes("--ink")]).toEqual([
    200,
    true,
  ]);
  expect((await get("/docs/brand.md")).status).toBe(200);
  expect((await get("/docs/agent.md")).status).toBe(404);
  const none = await get("/nope");
  expect([none.status, await none.text()]).toEqual([404, "not found"]);
});
