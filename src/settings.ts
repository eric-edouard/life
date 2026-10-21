import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Engine } from "./schema";
import { DATA, ROOT, TEST } from "./truth";

// What makes one install differ from another, in one file: who it serves, where its parts are, what is turned on.
// Secrets are not here: they stay in the environment (`.env` for a checkout, the app passes them to the helper). A
// part left out is off. A test run reads its own (src/test-data/settings.json), never his.

export const SETTINGS = TEST
  ? join(DATA, "settings.json")
  : join(ROOT, "derived", "settings.json");

export const Settings = z
  .object({
    /** The daily restic snapshot (`backup.ts`): its repository, and the command that prints its password. Without it, no backup. */
    backup: z
      .object({ password: z.string(), repository: z.string() })
      .strict()
      .optional(),
    /** The connector (/mcp) and its sign-in; without it Life serves no HTTP at all. */
    connector: z
      .object({
        /** The check page's public client at the issuer (PKCE, no secret). */
        client: z.string(),
        /** The OAuth server whose tokens it accepts. */
        issuer: z.url(),
        /** Its public address, where clients reach /mcp. */
        origin: z.url(),
        /** The one subject (`sub`) let in: the owner. */
        owner: z.string(),
      })
      .strict()
      .optional(),
    /** The model runner the memory steps use. */
    engine: Engine.default("claude"),
    /** The chat with Life's retired bot (a chat key): its messages were Life's output, never facts. */
    lifeChat: z.string().optional(),
    /** lifelog's server; its token is `LIFELOG_TOKEN`. */
    lifelog: z.object({ url: z.url() }).strict().optional(),
    /** Life's own mail: its sender and the owner's address, the only recipient. Without it nothing is mailed. */
    mail: z.object({ from: z.email(), to: z.email() }).strict().optional(),
    /** A word lifelog hears in place of the agent's name. */
    misheard: z.string().optional(),
    /** The Google calendar the moments are projected on (`past.ts`), through `gog` as this account. */
    past: z
      .object({ account: z.string(), calendar: z.string() })
      .strict()
      .optional(),
    /** Who mails him his agents' reports: their mail is judged, not dropped as automated. */
    reports: z.array(z.email()).default([]),
    /** The folder holding his code repos, `~/` allowed: the git source reads nothing without it. */
    repos: z.string().optional(),
  })
  .strict();
export type Settings = z.infer<typeof Settings>;

/** The settings in `path`; a missing file is every default, a corrupt one throws (never a silent switch of engine). */
export const readSettings = (path = SETTINGS): Settings =>
  Settings.parse(
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}
  );

let read: Settings | undefined;
/** This process's settings, read once. */
export const settings = () => {
  read ??= readSettings();
  return read;
};

/** Writes one part, keeping the rest. */
export async function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K]
) {
  read = Settings.parse({ ...readSettings(), [key]: value });
  await Bun.write(SETTINGS, `${JSON.stringify(read, null, 2)}\n`);
}

/** The connector's settings; only code that runs behind it (server.ts checks it is there) asks. */
export function connector() {
  const c = settings().connector;
  if (!c) {
    throw new Error("the connector is not set up (settings: connector)");
  }
  return {
    ...c,
    /** The resource's OAuth metadata; also the tunnel's health probe (src/tunnel.ts). */
    metadata: `${c.origin}/.well-known/oauth-protected-resource/mcp`,
    resource: `${c.origin}/mcp`,
  };
}

const TILDE = /^~(?=\/|$)/;
/** A path from settings, `~/` expanded. */
export const expand = (path: string) => path.replace(TILDE, homedir());
