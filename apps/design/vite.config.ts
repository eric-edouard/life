// The designs app: a viewer over docs/design, themed by assets/brand/tokens.css. Both folders are served at their repo
// paths, so every design's own relative links keep working; the build copies only what git tracks, so a deploy is a
// commit's content and nothing is a second source.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
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

/** The files of docs/design: in dev, the working tree's (new designs show before they are committed); built, git's. */
const filesOf = (built: boolean) =>
  execFileSync(
    "git",
    [
      "ls-files",
      ...(built ? [] : ["--others", "--exclude-standard", "--cached"]),
      "--",
      ...SERVED,
    ],
    { cwd: REPO, encoding: "utf8" }
  )
    .split("\n")
    .filter((f) => f && existsSync(join(REPO, f)));

function designFiles(): Plugin {
  let built = false;
  return {
    configResolved: (config) => {
      built = config.command === "build";
    },
    configureServer: (server) => {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent(
          (req.url ?? "").split("?")[0] ?? ""
        ).slice(1);
        const file = join(REPO, path);
        if (
          !(SERVED.some((s) => path.startsWith(`${s}/`)) && existsSync(file)) ||
          statSync(file).isDirectory()
        ) {
          return next();
        }
        res.setHeader(
          "Content-Type",
          TYPES[extname(file)] ?? "application/octet-stream"
        );
        createReadStream(file).pipe(res);
      });
    },
    load: (id) =>
      id === `\0${LIST}`
        ? `export default ${JSON.stringify(filesOf(built).filter((f) => f.startsWith("docs/")))};`
        : undefined,
    name: "design-files",
    resolveId: (id) => (id === LIST ? `\0${LIST}` : undefined),
    writeBundle: (options) => {
      for (const f of filesOf(true)) {
        const to = join(options.dir ?? "dist", f);
        mkdirSync(dirname(to), { recursive: true });
        cpSync(join(REPO, f), to);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), designFiles()],
});
