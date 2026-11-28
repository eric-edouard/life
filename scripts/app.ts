import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { EMBEDDER_FILE } from "@life/server/src/core/embedder";
import {
  bundleLlama,
  download,
  type Pin,
  resticRelease,
  uvRelease,
} from "@life/server/src/core/pinned";
import { execOk } from "@life/server/src/core/proc";
import { buildHost } from "../apps/lifelog/apps/server/scripts/build-host";
import {
  bundleBridges,
  bundledNotice,
  bundleGit,
  bundleGog,
} from "./bundled-tools";

// Life.app, assembled: the menu-bar app (apps/mac/, Swift) as its executable, the helper (scripts/helper.ts) in
// Contents/Helpers with its files in Contents/Resources/life, and what voice's launchd jobs run (`host/voice.ts`): its
// server, the Mac helper, restic and uv in Contents/Helpers, speaker recognition's files and the embedder's model in
// Contents/Resources, llama.cpp's server shared with the describer, the pinned codex the helper's own, git and gog in
// Helpers/tools/bin and the messaging bridges in Helpers/bridges (`scripts/bundled-tools.ts`). Signed: with `LIFE_SIGN_IDENTITY` (an Apple-issued
// certificate, Apple Development or Developer ID, by hash or name, from `.env`) under the hardened runtime, which
// loads Sparkle only from the same team (so no self-signed one), else ad hoc. An ad hoc app is a new app to macOS at each build, so
// it loses its Keychain items and Full Disk Access; one certificate keeps them (a Developer ID for a release).
// Usage: `bun scripts/app.ts [out]`; `--sparkle` only fetches Sparkle (the gate's Swift build needs it).

const ROOT = join(import.meta.dir, "..");
const sparkleOnly = process.argv[2] === "--sparkle";
const out = (!sparkleOnly && process.argv[2]) || join(ROOT, "dist");
const app = join(out, "Life.app");
const contents = join(app, "Contents");
const identity = process.env.LIFE_SIGN_IDENTITY ?? "-";
const version = process.env.LIFE_VERSION ?? "0.1.0";
const arch = process.arch === "arm64" ? "arm64" : "amd64";

const hardened =
  identity === "-" ? [] : ["--options", "runtime", "--timestamp"];
const run = (cmd: string[], cwd = ROOT) =>
  execOk(cmd, { cwd, timeout: 900_000 });
const sign = (file: string) =>
  run(["codesign", "--force", "--sign", identity, ...hardened, file]);

/** Sparkle, pinned: its release for Swift packages, checked against this checksum before it is unpacked. */
const SPARKLE = {
  sha256: "17e28312b8e18ab7cdbbe09a6fb28cc55a5479ec6c371dbc07cdecd2a14fd959",
  url: "https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-for-Swift-Package-Manager.zip",
};
const MAC = join(ROOT, "apps", "mac");
const FRAMEWORKS = join(MAC, "Frameworks");

/** Sparkle's xcframework in apps/mac/Frameworks, once. */
async function sparkle() {
  if (existsSync(join(FRAMEWORKS, "Sparkle.xcframework"))) {
    return;
  }
  const zip = await download(SPARKLE, join(out, "sparkle.zip"));
  await mkdir(FRAMEWORKS, { recursive: true });
  await run(["ditto", "-x", "-k", zip, FRAMEWORKS]);
}

/** What macOS shows when Life asks for a permission, and what keeps it a menu-bar app. */
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Life</string>
  <key>CFBundleIconFile</key><string>Life</string>
  <key>CFBundleIdentifier</key><string>app.life.mac</string>
  <key>CFBundleName</key><string>Life</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>ATSApplicationFontsPath</key><string>Fonts</string>
  <key>SUFeedURL</key><string>${process.env.LIFE_APPCAST_URL ?? ""}</string>
  <key>SUPublicEDKey</key><string>${process.env.LIFE_SPARKLE_KEY ?? ""}</string>
  <key>NSContactsUsageDescription</key><string>Life reads your contacts to know who wrote to you.</string>
  <key>NSCalendarsFullAccessUsageDescription</key><string>Life writes what happened as past events, when you turn that on.</string>
  <key>NSAppleEventsUsageDescription</key><string>Life keeps the apps it archives open.</string>
</dict></plist>
`;

/** The helper is Bun: its JIT needs these under the hardened runtime. */
const HELPER_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
`;

/** What the app and life-eventkit ask macOS for, under the hardened runtime. */
const APP_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.personal-information.calendars</key><true/>
  <key>com.apple.security.personal-information.addressbook</key><true/>
  <key>com.apple.security.automation.apple-events</key><true/>
</dict></plist>
`;

if (sparkleOnly) {
  await sparkle();
  process.exit(0);
}
await rm(app, { force: true, recursive: true });
await mkdir(join(contents, "MacOS"), { recursive: true });
await mkdir(join(contents, "Helpers"), { recursive: true });
await mkdir(join(contents, "Resources"), { recursive: true });

await sparkle();
await run(["swift", "build", "-c", "release"], MAC);
const bin = (
  await run(["swift", "build", "-c", "release", "--show-bin-path"], MAC)
).trim();
await cp(join(bin, "LifeApp"), join(contents, "MacOS", "Life"));
await mkdir(join(contents, "Frameworks"), { recursive: true });
const framework = join(contents, "Frameworks", "Sparkle.framework");
await run(["ditto", join(bin, "Sparkle.framework"), framework]);
await rm(join(framework, "Versions", "B", "XPCServices"), {
  force: true,
  recursive: true,
});
for (const helper of ["life-eventkit", "life-foundation-model"]) {
  // biome-ignore lint/performance/noAwaitInLoops: two small copies
  await cp(join(bin, helper), join(contents, "Helpers", helper));
}

// llama.cpp's server for the describer (photo descriptions), with the libraries it loads from beside it, signed.
await bundleLlama(
  join(contents, "Helpers", "llama"),
  join(contents, "Resources", "llama.cpp-LICENSE"),
  out,
  sign
);

// Voice: its server (one Bun binary, its licenses to Resources: Helpers holds only code), the Mac helper (Swift),
// restic and uv from their releases, speaker recognition's files (installed by `voice run identity`) and the
// embedder's model. Downloads are kept in lifelog's own cache, beside Lifelog Host's build's.
const LIFELOG = join(ROOT, "apps", "lifelog");
const helpers = join(contents, "Helpers");
const resources = join(contents, "Resources");
const fetched = (pin: Pin) =>
  download(pin, join(LIFELOG, ".build", "host-downloads", basename(pin.url)));
const quiet = ["--package-path", join(LIFELOG, "apps", "mac-quiet")];
const scratch = [
  "--scratch-path",
  join(LIFELOG, ".build", "mac-quiet-release"),
];
await run([
  "swift",
  "build",
  "-c",
  "release",
  ...quiet,
  ...scratch,
  "--product",
  "lifelog-quiet",
]);
const quietBin = (
  await run([
    "swift",
    "build",
    "-c",
    "release",
    ...quiet,
    ...scratch,
    "--show-bin-path",
  ])
).trim();
await cp(join(quietBin, "lifelog-quiet"), join(helpers, "lifelog-quiet"));
await buildHost(helpers);
await rename(join(helpers, "NOTICE"), join(resources, "voice-NOTICE"));
await run([
  "sh",
  "-c",
  'bunzip2 -c "$1" > "$2"',
  "sh",
  await fetched(resticRelease(arch)),
  join(helpers, "restic"),
]);
const uv = uvRelease(arch);
await run([
  ...["tar", "-xzf", await fetched(uv), "-C", helpers],
  ...["--strip-components", "1", `${basename(uv.url, ".tar.gz")}/uv`],
]);
await run(["chmod", "755", join(helpers, "restic"), join(helpers, "uv")]);
await mkdir(join(resources, "embedder"));
await cp(
  await fetched(EMBEDDER_FILE),
  join(resources, "embedder", "model.gguf")
);
await writeFile(
  join(resources, "embedder", "NOTICE"),
  "The model (EmbeddingGemma-300M) is Gemma, provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms.\n"
);
await mkdir(join(resources, "identity"));
for (const f of ["app.py", "pyproject.toml", "uv.lock"]) {
  // biome-ignore lint/performance/noAwaitInLoops: three small copies
  await cp(
    join(LIFELOG, "apps", "identity", f),
    join(resources, "identity", f)
  );
}

// git and gog on one PATH folder, the bridges built for this chip, and where their sources are.
const tools = join(helpers, "tools");
const toolsCache = join(LIFELOG, ".build", "host-downloads");
await bundleGit(tools, toolsCache, sign);
await bundleGog(tools, toolsCache, sign);
await bundleBridges(
  join(helpers, "bridges"),
  join(toolsCache, "bridges-src"),
  sign
);
await writeFile(join(resources, "bundled-tools-NOTICE"), bundledNotice());

const helper = join(out, "helper");
await run(["bun", join(ROOT, "scripts", "helper.ts"), helper]);
await cp(join(helper, "life"), join(contents, "Helpers", "life"));
await cp(join(helper, "resources"), join(contents, "Resources", "life"), {
  recursive: true,
});
// Life's type (docs/brand.md), Source Serif 4 and IBM Plex Mono (OFL, their licences beside them), registered by
// ATSApplicationFontsPath.
await cp(join(MAC, "Fonts"), join(contents, "Resources", "Fonts"), {
  recursive: true,
});
await writeFile(join(contents, "Info.plist"), PLIST);

// Life's icon from assets/icon (rsvg-convert, Homebrew's librsvg): app.svg as the bundle's icon at every size macOS
// asks for.
const ICON = join(ROOT, "assets", "icon");
const iconset = join(out, "Life.iconset");
await mkdir(iconset, { recursive: true });
await Promise.all(
  [16, 32, 128, 256, 512].flatMap((size) =>
    [1, 2].map((scale) =>
      run([
        "rsvg-convert",
        "-w",
        String(size * scale),
        "-h",
        String(size * scale),
        "-o",
        join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
        join(ICON, "app.svg"),
      ])
    )
  )
);
await run([
  "iconutil",
  "-c",
  "icns",
  "-o",
  join(contents, "Resources", "Life.icns"),
  iconset,
]);
// The L (the menu bar's) and the whole wordmark, as vector template images: at 72 dpi their 18 px high are 18 pt.
await Promise.all(
  ["life-l", "life"].map((name) =>
    run([
      "rsvg-convert",
      "-f",
      "pdf",
      "-d",
      "72",
      "-p",
      "72",
      "-h",
      "18",
      "-o",
      join(contents, "Resources", `${name}.pdf`),
      join(ROOT, "assets", "brand", `${name}.svg`),
    ])
  )
);

// Inside out: the helper first, then the app around it.
const entitlements = join(out, "helper.entitlements");
await writeFile(entitlements, HELPER_ENTITLEMENTS);
const appEntitlements = join(out, "app.entitlements");
await writeFile(appEntitlements, APP_ENTITLEMENTS);
await run([
  "codesign",
  "--force",
  "--sign",
  identity,
  ...hardened,
  "--entitlements",
  entitlements,
  join(contents, "Helpers", "life"),
]);
await run([
  "codesign",
  "--force",
  "--sign",
  identity,
  ...hardened,
  "--entitlements",
  appEntitlements,
  join(contents, "Helpers", "life-eventkit"),
]);
// Voice's server is Bun too: the helper's entitlements.
await run([
  "codesign",
  "--force",
  "--sign",
  identity,
  ...hardened,
  "--entitlements",
  entitlements,
  join(helpers, "lifelog-server"),
]);
for (const tool of ["life-foundation-model", "lifelog-quiet", "restic", "uv"]) {
  // biome-ignore lint/performance/noAwaitInLoops: signing order matters
  await sign(join(helpers, tool));
}
// Sparkle's parts, inside out (no --deep): its Autoupdate tool and Updater.app, then the framework.
for (const part of [
  join(framework, "Versions", "B", "Autoupdate"),
  join(framework, "Versions", "B", "Updater.app"),
  framework,
]) {
  // biome-ignore lint/performance/noAwaitInLoops: signing order matters
  await sign(part);
}
await run([
  "codesign",
  "--force",
  "--sign",
  identity,
  ...hardened,
  "--entitlements",
  appEntitlements,
  app,
]);
await run(["codesign", "--verify", "--deep", "--strict", app]);
console.log(`Life.app: ${app} (${identity === "-" ? "ad hoc" : identity})`);
