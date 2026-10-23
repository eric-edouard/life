import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MIN } from "../core/clock";
import { execOk } from "../core/proc";

// His repos from GitHub, for a host without his checkouts (the `forge` setting): each repo his projects list is cloned
// into the `repos` folder without a working tree (the git source reads only the log), then fetched every few minutes.
// The token, `GITHUB_TOKEN`, stays in the environment: git asks it of a credential helper, never stores it in a remote.

const API =
  "https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member";
const HELPER =
  '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f';
const NEXT = /<([^>]+)>;\s*rel="next"/;

/** Every repo the token can read, as owner/name. */
export async function visibleRepos(token: string, get = fetch) {
  const names: string[] = [];
  let url: string | undefined = API;
  while (url) {
    // biome-ignore lint/performance/noAwaitInLoops: pages follow one another
    const r: Response = await get(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
      },
    });
    if (!r.ok) {
      throw new Error(`GitHub: ${r.status} ${await r.text()}`);
    }
    names.push(
      ...((await r.json()) as { full_name: string }[]).map((x) => x.full_name)
    );
    url = r.headers.get("link")?.match(NEXT)?.[1];
  }
  return names;
}

/**
 * The GitHub repo each of his names stands for: an owner/name as it is, a bare name (a folder name on his Mac) the
 * one of that name the token sees. ponytail: two of his repos with one name, the first wins; an owner/name clone is
 * read under its name, not mapped to its project.
 */
export const forgeRepos = (names: string[], visible: string[]) => [
  ...new Set(
    names.flatMap((n) =>
      n.includes("/")
        ? [n]
        : visible
            .filter((v) => v.split("/")[1]?.toLowerCase() === n.toLowerCase())
            .slice(0, 1)
    )
  ),
];

/** Clones what is not in `root` yet and fetches the rest, one after another; a repo that fails throws after the others ran. */
export async function mirrorForge(
  names: string[],
  root: string,
  token = process.env.GITHUB_TOKEN,
  get = fetch
) {
  if (!token) {
    throw new Error("no GITHUB_TOKEN");
  }
  mkdirSync(root, { recursive: true });
  const git = [
    "git",
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${HELPER}`,
  ];
  const errors: string[] = [];
  const visible = await visibleRepos(token, get);
  for (const full of forgeRepos(names, visible)) {
    const dir = join(root, full.split("/")[1] ?? full);
    // biome-ignore lint/performance/noAwaitInLoops: one git at a time
    await execOk(
      existsSync(dir)
        ? [...git, "-C", dir, "fetch", "--all", "--prune", "--quiet"]
        : [
            ...git,
            "clone",
            "--no-checkout",
            "--quiet",
            `https://github.com/${full}.git`,
            dir,
          ],
      { env: { ...process.env, GITHUB_TOKEN: token }, timeout: 30 * MIN }
    ).catch((e: Error) => errors.push(`${full}: ${e.message}`));
  }
  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}
