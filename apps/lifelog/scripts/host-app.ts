// Lifelog Host.app (packaging 4.6b): the menu-bar app, with the server, the Mac helper, cloudflared, restic, Codex, uv and
// llama.cpp's server in Contents/Helpers, speaker recognition's files (apps/identity) in Contents/Resources/identity and
// search by meaning's model in Contents/Resources/embedder; its icon is the iPhone app's (AppIcon.icon), its menu-bar
// mark the same ring and dot.
//   bun run host:app [out]    (default .build/host; signed ad hoc unless LIFELOG_SIGN_IDENTITY is set)
// An identity (Developer ID, for a release) signs under the hardened runtime, which the server, a Bun binary, needs
// JIT entitlements for; ad hoc has no runtime, as in Life's scripts/app.ts.
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { $ } from "bun";
import { EMBEDDER_FILE } from "../../server/src/core/embedder";
import {
  bundleLlama,
  download,
  type Pin,
  resticRelease,
  uvRelease,
} from "../../server/src/core/pinned";
import { buildHost } from "../apps/server/scripts/build-host";

const root = resolve(import.meta.dir, "..");
const out = resolve(process.argv[2] ?? join(root, ".build/host"));
const app = join(out, "Lifelog Host.app");
const contents = join(app, "Contents");
const helpers = join(contents, "Helpers");
const resources = join(contents, "Resources");
const swift = join(root, ".build/mac-quiet-release");
const identity = process.env.LIFELOG_SIGN_IDENTITY ?? "-";
const version = process.env.LIFELOG_VERSION ?? "1.0";
const hardened =
  identity === "-" ? [] : ["--options", "runtime", "--timestamp"];
const arch = process.arch === "arm64" ? "arm64" : "amd64";
const triple = `${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
const codex = `codex-${triple}`;
// The commit it is built from, which Host passes to the server as BUILD_SHA.
const commit = (await $`git -C ${root} rev-parse HEAD`.text()).trim();

/** cloudflared ("My own domain"), restic (backups), Codex (summaries on ChatGPT), uv (speaker recognition's install)
 * from their official GitHub releases (llama.cpp, for search by meaning's embedder, is `bundleLlama`), and the embedder's model (Life's
 * core/embedder.ts) from Hugging Face at a fixed revision, all pinned by sha256. */
const TOOLS = {
  cloudflared: {
    sha256:
      arch === "arm64"
        ? "a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70"
        : "903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f",
    url: `https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-darwin-${arch}.tgz`,
  },
  codex: {
    sha256:
      arch === "arm64"
        ? "b293a0fcdd871900a44c0a4f40a1aa401b31e02854f790ebdb8bd5d1177fd1fe"
        : "d68e39d8f62639f33f7d00656554cb9c3ef7809e664a3827e62ab3ace3c21b21",
    url: `https://github.com/openai/codex/releases/download/rust-v0.162.1/${codex}.tar.gz`,
  },
  embedder: EMBEDDER_FILE,
  restic: resticRelease(arch),
  uv: uvRelease(arch),
};

/** The release's file, downloaded once into .build/host-downloads and refused unless it matches its sha256. */
const fetched = (tool: Pin) =>
  download(tool, join(root, ".build/host-downloads", basename(tool.url)));

/** The menu bar's mark at 18 pt: the iPhone icon's ring (outer 316, inner 244 of 1024) and dot (128), filling it. */
const MENUBAR = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
<path fill-rule="evenodd" d="M1 9a8 8 0 1 0 16 0a8 8 0 1 0 -16 0ZM2.82 9a6.18 6.18 0 1 0 12.36 0a6.18 6.18 0 1 0 -12.36 0Z"/>
<circle cx="9" cy="9" r="3.24"/>
</svg>
`;

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>LifelogHost</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIconName</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.lifelog.host</string>
  <key>CFBundleName</key><string>Lifelog Host</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LifelogCommit</key><string>${commit}</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`;

/** The server is Bun: its JIT needs these under the hardened runtime. */
const SERVER_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
`;

if (!Bun.which("rsvg-convert")) {
  throw new Error(
    "rsvg-convert is missing: `brew install librsvg` (it draws the menu-bar icon)"
  );
}

await rm(app, { force: true, recursive: true });
await Promise.all(
  [join(contents, "MacOS"), helpers, resources].map((dir) =>
    mkdir(dir, { recursive: true })
  )
);

await $`swift build -c release --package-path ${join(root, "apps/mac-quiet")} --scratch-path ${swift}`;
const bin = (
  await $`swift build -c release --package-path ${join(root, "apps/mac-quiet")} --scratch-path ${swift} --show-bin-path`.text()
).trim();
await cp(join(bin, "LifelogHost"), join(contents, "MacOS/LifelogHost"));
await cp(join(bin, "lifelog-quiet"), join(helpers, "lifelog-quiet"));
await buildHost(helpers);
// The server's third-party licenses: Helpers holds only code to sign, so they go to Resources.
await rename(join(helpers, "NOTICE"), join(resources, "NOTICE"));
await $`tar -xzf ${await fetched(TOOLS.cloudflared)} -C ${helpers} cloudflared`;
await $`bunzip2 -c ${await fetched(TOOLS.restic)} > ${join(helpers, "restic")}`;
await $`tar -xzf ${await fetched(TOOLS.codex)} -C ${helpers} ${codex}`;
await rename(join(helpers, codex), join(helpers, "codex"));
await $`tar -xzf ${await fetched(TOOLS.uv)} -C ${helpers} --strip-components 1 uv-${triple}/uv`;
await $`chmod 755 ${join(helpers, "cloudflared")} ${join(helpers, "restic")} ${join(helpers, "codex")} ${join(helpers, "uv")}`;
// llama.cpp's server and the libraries it loads from beside it (@loader_path); the model and both licenses go to
// Resources.
const llama = join(helpers, "llama");
const embedder = join(resources, "embedder");
await mkdir(embedder);
await bundleLlama(
  llama,
  join(embedder, "llama.cpp-LICENSE"),
  join(root, ".build/host-downloads"),
  (file) => $`codesign --force --sign ${identity} ${hardened} ${file}`
);
await cp(await fetched(TOOLS.embedder), join(embedder, "model.gguf"));
await writeFile(
  join(embedder, "NOTICE"),
  "The model (EmbeddingGemma-300M) is Gemma, provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms.\n"
);
// Host installs speaker recognition from these (uv sync --frozen, app.py download) into Application Support.
await mkdir(join(resources, "identity"));
await $`cp ${["app.py", "pyproject.toml", "uv.lock"].map((f) => join(root, "apps/identity", f))} ${join(resources, "identity")}`;
await writeFile(join(contents, "Info.plist"), PLIST);

// The app icon (Assets.car and AppIcon.icns) from the iPhone's Icon Composer file, and the menu bar's template PDF
// (rsvg-convert, Homebrew's librsvg; at 72 dpi its 18 px are 18 pt).
await $`xcrun actool --compile ${resources} --platform macosx --minimum-deployment-target 15.0 --app-icon AppIcon --output-partial-info-plist ${join(out, "icon.plist")} ${join(root, "apps/ios/Lifelog/AppIcon.icon")}`.quiet();
const menubar = join(out, "menubar.svg");
await writeFile(menubar, MENUBAR);
await $`rsvg-convert -f pdf -d 72 -p 72 -o ${join(resources, "menubar.pdf")} ${menubar}`;

// Inside out: each helper, then the app around them.
const entitlements = join(out, "server.entitlements");
await writeFile(entitlements, SERVER_ENTITLEMENTS);
await $`codesign --force --sign ${identity} ${hardened} --entitlements ${entitlements} ${join(helpers, "lifelog-server")}`;
for (const helper of [
  "lifelog-quiet",
  "cloudflared",
  "restic",
  "codex",
  "uv",
]) {
  // biome-ignore lint/performance/noAwaitInLoops: signing order matters
  await $`codesign --force --sign ${identity} ${hardened} ${join(helpers, helper)}`;
}
await $`codesign --force --sign ${identity} ${hardened} ${app}`;
await $`codesign --verify --deep --strict ${app}`;
console.log(
  `built ${app} (${identity === "-" ? "ad hoc" : identity}, ${arch})`
);
