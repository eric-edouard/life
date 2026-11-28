// The designs app: a viewer over docs/design, themed by assets/brand/tokens.css. The Mac serves it from the live
// checkout, so what it shows is always what the checkout holds: nothing is built, copied or deployed. On the owner's
// Mac (not in the repo): the LaunchAgent `com.ericedouard.life-designs` runs `bun run design` in ~/Work/life, and the
// cloudflared route `designs.ericedouard.com` in ~/.cloudflared/config.yml points at its port. Both folders are served at their repo paths, so every design's
// own relative links keep working.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { LATEST_URL, newestCommitsOf, ROOT } from "./src/catalog";

const REPO = join(import.meta.dirname, "../..");
const SERVED = ["docs/design", "assets/brand"];
/** The parity board's last run (`bun run parity`): never committed, served for the Parity tab. Its pictures are the app's
 *  flow shots over the prototype's made-up data. */
const PARITY = "docs/design/2026-11-23-chat-first/parity";
const parityFiles = () =>
  existsSync(join(REPO, PARITY))
    ? readdirSync(join(REPO, PARITY))
        .filter((f) => f === "board.json" || f.endsWith(".jpg"))
        .map((f) => `${PARITY}/${f}`)
    : [];
const LIST = "virtual:design-files";
const TYPES: Record<string, string> = {
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
};

/** The files the app may serve: docs/design's and the brand's in the working tree, committed or not (a new design shows
 *  before it is committed), never one git ignores (generated output such as the parity board's pictures). */
const servedFiles = () =>
  execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SERVED],
    { cwd: REPO, encoding: "utf8" }
  )
    .split("\n")
    .concat(parityFiles())
    .filter((f) => f && existsSync(join(REPO, f)));

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

/** Each docs/design file's newest commit, in one git log: [path under docs/design, unix seconds]. Read again only
 *  when HEAD moved. */
let latest = { commits: [] as [string, number][], head: "" };
const latestCommits = () => {
  const head = git("rev-parse", "HEAD").trim();
  if (head !== latest.head) {
    latest = { commits: readLatestCommits(), head };
  }
  return latest.commits;
};
const readLatestCommits = () =>
  newestCommitsOf(
    git("log", "--format=%x00%ct", "--name-only", "--", ROOT)
  ).map(([f, t]): [string, number] => [f.slice(ROOT.length), t]);

function servedFolders(): Plugin {
  let served = new Set(servedFiles());
  return {
    configureServer: (server) => {
      // A file added or removed changes what is served and listed: read the list again and reload.
      server.watcher.add(SERVED.map((s) => join(REPO, s)));
      server.watcher.on("all", (event) => {
        if (event !== "add" && event !== "unlink") {
          return;
        }
        served = new Set(servedFiles());
        const list = server.moduleGraph.getModuleById(`\0${LIST}`);
        if (list) {
          server.moduleGraph.invalidateModule(list);
          server.ws.send({ type: "full-reload" });
        }
      });
      // Cloudflare rewrites "no-cache" on .css and .js to its 4-hour browser cache; "no-store" it leaves alone.
      server.middlewares.use((_req, res, next) => {
        const set = res.setHeader.bind(res);
        res.setHeader = (name, value) =>
          set(
            name,
            name.toLowerCase() === "cache-control" ? "no-store" : value
          );
        next();
      });
      server.middlewares.use((req, res, next) => {
        if (req.url === LATEST_URL) {
          // Read at each ask (the sheet opening), so a fast-forward of the checkout shows with no restart.
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(latestCommits()));
          return;
        }
        const path = decodeURIComponent(
          (req.url ?? "").split("?")[0] ?? ""
        ).slice(1);
        if (!served.has(path)) {
          return next();
        }
        res.setHeader(
          "Content-Type",
          TYPES[extname(path)] ?? "application/octet-stream"
        );
        createReadStream(join(REPO, path)).pipe(res);
      });
    },
    load: (id) =>
      id === `\0${LIST}`
        ? `export default ${JSON.stringify([...served].filter((f) => f.startsWith("docs/") && !f.startsWith(PARITY)))};`
        : undefined,
    name: "served-folders",
    resolveId: (id) => (id === LIST ? `\0${LIST}` : undefined),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), servedFolders()],
  server: {
    allowedHosts: ["designs.ericedouard.com"],
    // Only what the app and its designs need is reachable through the tunnel, never the rest of the repo.
    fs: {
      allow: [
        import.meta.dirname,
        join(REPO, "docs/design"),
        join(REPO, "assets/brand"),
        join(REPO, "node_modules"),
      ],
    },
    host: "127.0.0.1",
    port: 8766,
    strictPort: true,
  },
});
