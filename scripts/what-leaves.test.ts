import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LIFE_CODE_DIR } from "@life/server/src/core/paths";
import { repoFiles } from "@life/server/src/core/proc";

// The audit test (AGENTS.md "The audit test"): every host Life talks to is named in SECURITY.md's "What leaves the Mac",
// with what leaves, to whom and how to turn it off. A NOT_CALLED host is a name the code carries and never sends to;
// each integration's own privacy line is checked in apps/server/src/host/integrations.test.ts.

const URL_HOST = /https?:\/\/([a-zA-Z0-9.-]+)/g;
const LOOPBACK = new Set(["localhost", "127.0.0.1"]);
// The names meant never to resolve, which no run reaches.
const RESERVED = [".test", ".example", ".invalid", ".localhost"];

// Hosts the code names but sends nothing to, each with its reason.
const NOT_CALLED: Record<string, string> = {
  "claude.ai": "a to-do item's link he opens in his browser",
  "code.claude.com": "a help link",
  "designs.ericedouard.com": "the designs app, a developer's tool",
  "docs.perplexity.ai": "a price's source, in a comment",
  "docs.tavily.com": "a price's source, in a comment",
  "maps.apple.com": "a link to a place, opened by him",
  "matrix.to": "a link inside a message, parsed",
  "my.telegram.org": "where he makes his Telegram app keys, shown to him",
  "openai.com": "a price's source, in a comment",
  "platform.claude.com": "a price's source, in a comment",
  "t.me": "a Telegram link, parsed or shown",
  "tailscale.com": "a help link",
  "wa.me": "a WhatsApp link, parsed or shown",
  "www.apple.com": "a plist's DTD",
  "www.facebook.com": "a contact card's link, parsed",
  "www.google.com": "a Google Maps link to a place, opened by him",
  "www.w3.org": "an XML namespace",
};

const isTestFile = (path: string) =>
  path.endsWith(".test.ts") ||
  path.includes("/Tests/") ||
  path.includes("/E2E/") ||
  basename(path).startsWith("test_");

const isReserved = (host: string) =>
  RESERVED.some((end) => host.endsWith(end)) ||
  host === "example.com" ||
  host.endsWith(".example.com");

const security = readFileSync(join(LIFE_CODE_DIR, "SECURITY.md"), "utf8").split(
  "\n"
);
const start = security.findIndex((line) =>
  line.startsWith("## What leaves the Mac")
);
const section = security
  .slice(
    start,
    security.findIndex((line, i) => i > start && line.startsWith("## "))
  )
  .join("\n");

/** Every host the shipped code names, with the files naming it. */
const hosts = new Map<string, Set<string>>();
for (const file of repoFiles(
  LIFE_CODE_DIR,
  ["apps", "scripts", "packages", "tools"],
  [".ts", ".tsx", ".swift", ".py", ".kt"]
).filter((f) => !isTestFile(f))) {
  for (const match of readFileSync(join(LIFE_CODE_DIR, file), "utf8").matchAll(
    URL_HOST
  )) {
    const host = match[1].toLowerCase().replace(/\.$/, "");
    if (LOOPBACK.has(host) || !host.includes(".") || isReserved(host)) {
      continue;
    }
    hosts.set(host, (hosts.get(host) ?? new Set()).add(file));
  }
}

test('every host the code names is in SECURITY.md "What leaves the Mac", or in NOT_CALLED', () => {
  const missing = [...hosts]
    .filter(([host]) => !(host in NOT_CALLED || section.includes(host)))
    .map(([host, files]) => `  ${host}\n    ${[...files].join("\n    ")}`);
  expect(
    missing.length === 0
      ? ""
      : `hosts missing from SECURITY.md "What leaves the Mac":\n${missing.join("\n")}\n\nName each in SECURITY.md "What leaves the Mac" (what leaves, to whom, how to turn it off), or add it to NOT_CALLED with why nothing is sent to it.`
  ).toBe("");
});

test("NOT_CALLED holds no entry the code no longer names", () => {
  expect(Object.keys(NOT_CALLED).filter((host) => !hosts.has(host))).toEqual(
    []
  );
});
