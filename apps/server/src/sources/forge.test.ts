import { expect, test } from "bun:test";
import { forgeRepos, visibleRepos } from "./forge";

test("forgeRepos: an owner/name as it is, a bare name by the repo of that name the token sees, each once", () => {
  const visible = ["ana-co/Kitchen", "me/kitchen", "me/garden"];
  expect(
    forgeRepos(["kitchen", "me/notes", "garden", "Garden", "nowhere"], visible)
  ).toEqual(["ana-co/Kitchen", "me/notes", "me/garden"]);
});

test("visibleRepos reads every page the token sees, and throws on a refusal", async () => {
  const pages: Record<string, Response> = {
    first: Response.json([{ full_name: "me/kitchen" }], {
      headers: {
        link: '<https://api.github.com/user/repos?page=2>; rel="next", <x>; rel="last"',
      },
    }),
    "https://api.github.com/user/repos?page=2": Response.json([
      { full_name: "me/garden" },
    ]),
  };
  const asked: string[] = [];
  const get = ((url: string, init: RequestInit) => {
    asked.push(
      `${url} ${(init.headers as Record<string, string>).authorization}`
    );
    return Promise.resolve(pages[url.includes("page=2") ? url : "first"]);
  }) as unknown as typeof fetch;
  expect(await visibleRepos("t0ken", get)).toEqual(["me/kitchen", "me/garden"]);
  expect(asked.every((a) => a.endsWith("Bearer t0ken"))).toBe(true);
  const refused = (() =>
    Promise.resolve(
      new Response("Bad credentials", { status: 401 })
    )) as unknown as typeof fetch;
  await expect(visibleRepos("bad", refused)).rejects.toThrow(
    "GitHub: 401 Bad credentials"
  );
});
