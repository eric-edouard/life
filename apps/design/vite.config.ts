// The designs app: a viewer over docs/design, themed by assets/brand/tokens.css. The Mac serves it from the live
// checkout (`bun run design`, kept up by launchd, at designs.ericedouard.com), so what it shows is always what the
// checkout holds: nothing is built, copied or deployed. Both folders are served at their repo paths, so every design's
// own relative links keep working.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const REPO = join(import.meta.dirname, "../..");
const SERVED = ["docs/design", "assets/brand"];
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

/** The files of docs/design in the working tree, committed or not (a new design shows before it is committed). */
const designFiles = () =>
  execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "docs/design",
    ],
    { cwd: REPO, encoding: "utf8" }
  )
    .split("\n")
    .filter((f) => f && existsSync(join(REPO, f)));

function servedFolders(): Plugin {
  return {
    configureServer: (server) => {
      // A design added or removed changes the list: reload it.
      server.watcher.add(join(REPO, "docs/design"));
      server.watcher.on("all", (event) => {
        if (event === "add" || event === "unlink") {
          const list = server.moduleGraph.getModuleById(`\0${LIST}`);
          if (list) {
            server.moduleGraph.invalidateModule(list);
            server.ws.send({ type: "full-reload" });
          }
        }
      });
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent(
          (req.url ?? "").split("?")[0] ?? ""
        ).slice(1);
        const file = join(REPO, path);
        const isServed = SERVED.some((s) => path.startsWith(`${s}/`));
        if (
          !isServed ||
          path.includes("..") ||
          !existsSync(file) ||
          statSync(file).isDirectory()
        ) {
          return next();
        }
        res.setHeader(
          "Content-Type",
          TYPES[extname(file)] ?? "application/octet-stream"
        );
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(file).pipe(res);
      });
    },
    load: (id) =>
      id === `\0${LIST}`
        ? `export default ${JSON.stringify(designFiles())};`
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
