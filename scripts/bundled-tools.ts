import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  download,
  GIT_SOURCE,
  GIT_VERSION,
  GOG_VERSION,
  gogRelease,
} from "@life/server/src/core/pinned";
import { execOk } from "@life/server/src/core/proc";
import { NETWORKS } from "@life/server/src/sources/networks";

// The programs Life runs that a new Mac does not have, built or fetched at a pinned version for Life.app (scripts/app.ts):
// git (macOS has none until the developer tools are installed, #1515) and gog in `Helpers/tools/bin`, one folder on the
// PATH of the helper and its agents (`apps/mac/Sources/LifeApp/Helper.swift`), and each messaging bridge in
// `Helpers/bridges/<network>` (`bundledBridge`, `host/bridges.ts`), so nothing is built with `go` on the user's Mac.
// Each is for the build machine's chip. A checkout builds the bridges alone: `bun scripts/bundled-tools.ts <folder>`,
// then `LIFE_BRIDGES_DIR=<folder>`.

/** Each bridge's release tag (its repository is in `NETWORKS`): bump one here to ship a newer bridge. */
export const BRIDGE_TAGS: Record<string, string> = {
  "beeper/line": "1.2.0",
  "mautrix/linkedin": "v0.2611.0",
  "mautrix/meta": "v0.2611.0",
  "mautrix/telegram": "v0.2611.0",
  "mautrix/whatsapp": "v0.2611.0",
};

/** Programs git runs as separate files that we keep: the rest of its install is scripts, extra tools and the manual. */
const GIT_KEPT = ["git", "git-remote-http", "git-http-fetch"];

/** `file` is the program of this name in `dir`, signed by `sign`. */
type Sign = (file: string) => Promise<unknown>;

/** git, built from its pinned source into `tools` (bin/git, libexec/git-core/…: it finds its helpers beside itself; no templates, which a signed app cannot hold: the helper's `GIT_TEMPLATE_DIR` is empty). */
export async function bundleGit(tools: string, cache: string, sign: Sign) {
  const src = join(cache, `git-${GIT_VERSION}`);
  const stage = join(cache, "git-stage");
  await rm(src, { force: true, recursive: true });
  await rm(stage, { force: true, recursive: true });
  await mkdir(src, { recursive: true });
  await execOk([
    ...[
      "tar",
      "-xJf",
      await download(GIT_SOURCE, join(cache, basename(GIT_SOURCE.url))),
    ],
    ...["-C", src, "--strip-components", "1"],
  ]);
  // No Rust, gettext, Perl, Python, expat or OpenSSL: Life needs none of what they add. RUNTIME_PREFIX makes the
  // install relocatable; symlinks, not hard links, for the 150 programs that are the one binary.
  await execOk(
    [
      ...["make", "-j", "6", "prefix=/usr", "RUNTIME_PREFIX=1", "NO_RUST=1"],
      ...[
        "NO_GETTEXT=1",
        "NO_TCLTK=1",
        "NO_PERL=1",
        "NO_PYTHON=1",
        "NO_EXPAT=1",
      ],
      ...["NO_OPENSSL=1", "NO_PCRE2=1", "NO_INSTALL_HARDLINKS=1"],
      ...[`DESTDIR=${stage}`, "install"],
    ],
    { cwd: src, timeout: 900_000 }
  );
  const exec = join(stage, "usr", "libexec", "git-core");
  for (const f of await readdir(exec, { withFileTypes: true })) {
    if (!(f.isSymbolicLink() || GIT_KEPT.includes(f.name))) {
      // biome-ignore lint/performance/noAwaitInLoops: one small removal each
      await rm(join(exec, f.name), { force: true, recursive: true });
    }
  }
  await mkdir(join(tools, "bin"), { recursive: true });
  await execOk([
    "ditto",
    join(stage, "usr", "libexec"),
    join(tools, "libexec"),
  ]);
  await execOk([
    "ditto",
    join(stage, "usr", "bin", "git"),
    join(tools, "bin", "git"),
  ]);
  const kept = join(tools, "libexec", "git-core");
  for (const f of [
    join(tools, "bin", "git"),
    ...GIT_KEPT.map((k) => join(kept, k)),
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: signing order is not important, one file each
    await sign(f);
  }
}

/** gog, from its pinned release, into `tools/bin`. */
export async function bundleGog(tools: string, cache: string, sign: Sign) {
  const pin = gogRelease(process.arch === "arm64" ? "arm64" : "amd64");
  await mkdir(join(tools, "bin"), { recursive: true });
  await execOk([
    ...["tar", "-xzf", await download(pin, join(cache, basename(pin.url)))],
    ...["-C", join(tools, "bin"), "gog"],
  ]);
  await sign(join(tools, "bin", "gog"));
}

/** Every network's bridge, built from its tag's source (Go, on this machine) into `dest/<network>`. */
export async function bundleBridges(dest: string, cache: string, sign?: Sign) {
  await mkdir(dest, { recursive: true });
  const cloned = new Set<string>();
  for (const n of NETWORKS) {
    const tag = BRIDGE_TAGS[n.repo];
    if (!tag) {
      throw new Error(`${n.repo}: no pinned tag in scripts/bundled-tools.ts`);
    }
    const src = join(cache, `${n.repo.replace("/", "-")}-${tag}`);
    if (!cloned.has(src)) {
      cloned.add(src);
      // biome-ignore lint/performance/noAwaitInLoops: the builds share the machine's cores
      await rm(src, { force: true, recursive: true });
      await execOk(
        [
          "git",
          "clone",
          "-q",
          "--depth",
          "1",
          "--branch",
          tag,
          `https://github.com/${n.repo}`,
          src,
        ],
        { timeout: 300_000 }
      );
    }
    const bin = join(dest, n.name);
    await execOk(
      [
        "go",
        "build",
        "-trimpath",
        "-ldflags=-s -w",
        "-tags",
        "goolm",
        "-o",
        bin,
        `./${n.cmd}`,
      ],
      { cwd: src, timeout: 900_000 }
    );
    await sign?.(bin);
  }
}

/** The licences and sources a copy of these programs carries (GPL v2 for git, AGPL for the mautrix bridges). */
export const bundledNotice = () =>
  [
    `git ${GIT_VERSION}, GPL v2: built unchanged from ${GIT_SOURCE.url}`,
    `gog ${GOG_VERSION}, MIT: https://github.com/steipete/gogcli/tree/v${GOG_VERSION}`,
    ...NETWORKS.map(
      (n) =>
        `${n.label} bridge ${BRIDGE_TAGS[n.repo]}, AGPL v3 (mautrix) or its own licence: built unchanged from https://github.com/${n.repo}/tree/${BRIDGE_TAGS[n.repo]}`
    ),
    "",
  ].join("\n");

if (import.meta.main) {
  const [, , dest] = process.argv;
  if (!dest) {
    throw new Error(
      "usage: bun scripts/bundled-tools.ts <folder for the bridges>"
    );
  }
  await bundleBridges(dest, join(dest, ".build"));
}
