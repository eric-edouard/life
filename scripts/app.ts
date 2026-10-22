import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execOk } from "../src/proc";

// Life.app, assembled: the menu-bar app (app/, Swift) as its executable, the helper (scripts/helper.ts) in
// Contents/Helpers with its files in Contents/Resources/life, signed: with `LIFE_SIGN_IDENTITY` (an Apple-issued
// certificate, Apple Development or Developer ID, by hash or name, from `.env`) under the hardened runtime, which
// loads Sparkle only from the same team (so no self-signed one), else ad hoc. An ad hoc app is a new app to macOS at each build, so
// it loses its Keychain items and Full Disk Access; one certificate keeps them (a Developer ID for a release).
// Usage: `bun scripts/app.ts [out]`.

const ROOT = join(import.meta.dir, "..");
const out = process.argv[2] ?? join(ROOT, "dist");
const app = join(out, "Life.app");
const contents = join(app, "Contents");
const identity = process.env.LIFE_SIGN_IDENTITY ?? "-";
const version = process.env.LIFE_VERSION ?? "0.1.0";

const run = (cmd: string[], cwd = ROOT) =>
  execOk(cmd, { cwd, timeout: 900_000 });

/** Sparkle, pinned: its release for Swift packages, checked against this checksum before it is unpacked. */
const SPARKLE = {
  sha256: "17e28312b8e18ab7cdbbe09a6fb28cc55a5479ec6c371dbc07cdecd2a14fd959",
  url: "https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-for-Swift-Package-Manager.zip",
};
const FRAMEWORKS = join(ROOT, "app", "Frameworks");

/** Sparkle's xcframework in app/Frameworks, once. */
async function sparkle() {
  if (existsSync(join(FRAMEWORKS, "Sparkle.xcframework"))) {
    return;
  }
  const zip = join(out, "sparkle.zip");
  await mkdir(out, { recursive: true });
  await run(["curl", "-sSL", "--max-time", "300", "-o", zip, SPARKLE.url]);
  const sum = createHash("sha256")
    .update(await Bun.file(zip).bytes())
    .digest("hex");
  if (sum !== SPARKLE.sha256) {
    throw new Error(`Sparkle's download does not match its checksum (${sum})`);
  }
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

await rm(app, { force: true, recursive: true });
await mkdir(join(contents, "MacOS"), { recursive: true });
await mkdir(join(contents, "Helpers"), { recursive: true });
await mkdir(join(contents, "Resources"), { recursive: true });

await sparkle();
await run(["swift", "build", "-c", "release"], join(ROOT, "app"));
const bin = (
  await run(
    ["swift", "build", "-c", "release", "--show-bin-path"],
    join(ROOT, "app")
  )
).trim();
await cp(join(bin, "LifeApp"), join(contents, "MacOS", "Life"));
await mkdir(join(contents, "Frameworks"), { recursive: true });
const framework = join(contents, "Frameworks", "Sparkle.framework");
await run(["ditto", join(bin, "Sparkle.framework"), framework]);
await rm(join(framework, "Versions", "B", "XPCServices"), {
  force: true,
  recursive: true,
});
await cp(
  join(bin, "life-eventkit"),
  join(contents, "Helpers", "life-eventkit")
);

const helper = join(out, "helper");
await run(["bun", join(ROOT, "scripts", "helper.ts"), helper]);
await cp(join(helper, "life"), join(contents, "Helpers", "life"));
await cp(join(helper, "resources"), join(contents, "Resources", "life"), {
  recursive: true,
});
// Ledger's type, Source Serif 4 and IBM Plex Mono (OFL, their licences beside them), registered by ATSApplicationFontsPath.
await cp(join(ROOT, "app", "Fonts"), join(contents, "Resources", "Fonts"), {
  recursive: true,
});
await writeFile(join(contents, "Info.plist"), PLIST);

// Life's icon from assets/icon (rsvg-convert, Homebrew's librsvg): app.svg as the bundle's icon at every size macOS
// asks for, menubar.svg as the menu bar's template image.
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
await run([
  "rsvg-convert",
  "-f",
  "pdf",
  // At 72 dpi its 18 px are 18 pt, the menu bar's size.
  "-d",
  "72",
  "-p",
  "72",
  "-o",
  join(contents, "Resources", "menubar.pdf"),
  join(ICON, "menubar.svg"),
]);

// Inside out: the helper first, then the app around it.
const entitlements = join(out, "helper.entitlements");
await writeFile(entitlements, HELPER_ENTITLEMENTS);
const appEntitlements = join(out, "app.entitlements");
await writeFile(appEntitlements, APP_ENTITLEMENTS);
const hardened =
  identity === "-" ? [] : ["--options", "runtime", "--timestamp"];
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
// Sparkle's parts, inside out (no --deep): its Autoupdate tool and Updater.app, then the framework.
for (const part of [
  join(framework, "Versions", "B", "Autoupdate"),
  join(framework, "Versions", "B", "Updater.app"),
  framework,
]) {
  // biome-ignore lint/performance/noAwaitInLoops: signing order matters
  await run(["codesign", "--force", "--sign", identity, ...hardened, part]);
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
