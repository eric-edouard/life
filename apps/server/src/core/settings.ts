import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Engine, SourceName } from "./names";
import { LIFE_STATE_DIR } from "./paths";
import { HOME } from "./platform";

// What makes one install differ from another, in one file: who it serves, where its parts are, what is turned on.
// Secrets are not here: they stay in the environment (`.env` for a checkout, the app passes them to the helper). A
// part left out is off. A test run reads its own (apps/server/src/test-data/state/settings.json), never his.

export const SETTINGS = join(LIFE_STATE_DIR, "settings.json");

export const Settings = z
  .object({
    agent: z
      .object({
        /** The user agent its calls start with; by default ChatGPT's for a pushed agent, Claude's for one that pulls. */
        client: z.string().optional(),
        misheard: z.array(z.string()).default([]),
        name: z.string(),
        /** For an agent that pulls: the command Life starts (in his home) with an event's JSON appended: a new ask, and a tick each minute (`startAgent`). */
        start: z.array(z.string()).min(1).optional(),
        /** How asks reach it: pushed as the MCP event `ask` (ChatGPT), or pulled by its own `read_open_agent_tasks` calls (Claude). */
        transport: z.enum(["mcp-event", "pull"]).default("mcp-event"),
        wake: z.array(z.string()).min(1),
      })
      .strict()
      .refine((a) => !a.start || a.transport === "pull", {
        message: "`start` is for an agent that pulls its asks",
      })
      .optional(),
    /** The daily restic snapshot (`backup.ts`): its repository, and the command that prints its password. Without it, no backup. */
    backup: z
      .object({ password: z.string(), repository: z.string() })
      .strict()
      .optional(),
    /** The connector (/mcp) and its sign-in (Life's own issuer, `oauth.ts`); without it Life serves no HTTP at all. */
    connector: z
      .object({
        /** Its public address, where clients reach /mcp. */
        origin: z.url(),
      })
      .strict()
      .optional(),
    /**
     * His daily ask (`dailyAsk`, host/agent.ts): his own text, handed to his agent once a day when his local time passes
     * `time`, so instructions it forgets come back. `on: false` keeps the text; without it, there is none.
     */
    daily_ask: z
      .object({
        on: z.boolean().default(true),
        text: z.string().trim().min(1),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM"),
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
    /** The calendar the moments are projected on (`host/past-calendar.ts`): a Google one through `gog` as `account`, or without one an Apple one through the app's EventKit tool. */
    past: z
      .object({ account: z.string().optional(), calendar: z.string() })
      .strict()
      .optional(),
    /** Who mails him his agents' reports: their mail is judged, not dropped as automated. */
    reports: z.array(z.email()).default([]),
    /** The folder holding his code repos, `~/` allowed: the git source reads nothing without it. */
    repos: z.string().optional(),
    /** The sources he turned on, by name: no other is read, searched or shown. */
    sources: z.array(SourceName).default([]),
    /**
     * His agent, the one "hey <name>" hands his words to (`hear.ts`, `host/agent.ts`): its name (what Life calls it, and
     * its Reminders board), the words that wake it, how lifelog mishears them (a misheard wake counts only on his own
     * turn, as low confidence), the user agent its connector calls start with, and how asks reach it. Without it
     * nothing wakes an agent.
     */
    /**
     * His to-do list, input and output (`apps/server/src/todo-list/`), and its one backend: his Apple Reminders (remctl) or
     * his Google Tasks (`gog` as `account`). On, Life acts there when he asks, keeps the board, and reads his changes back;
     * without it (the default), nothing in Life touches either.
     */
    todo_list: z
      .discriminatedUnion("backend", [
        z.object({ backend: z.literal("reminders") }).strict(),
        z
          .object({ account: z.string(), backend: z.literal("google") })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export type Settings = z.infer<typeof Settings>;

/** The settings in `path`; a missing file is every default, a corrupt one throws (never a silent switch of engine). */
export function readSettings(path = SETTINGS): Settings {
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return Settings.parse(raw);
}

/** Whole or not at all: a reader never parses half a file (a bad one stops the watcher and the nightly). */
function writeWhole(path: string, value: unknown) {
  // Each process its own temp file: the app starts several at once, each may rename an old file.
  writeFileSync(
    `${path}.${process.pid}.tmp`,
    `${JSON.stringify(value, null, 2)}\n`
  );
  renameSync(`${path}.${process.pid}.tmp`, path);
}

let read: Settings | undefined;
/** This process's settings, read once. */
export const settings = () => {
  read ??= readSettings();
  return read;
};

/** Writes some parts, keeping the rest (a part set to null is removed: off): the whole is checked before anything is written. */
export function setSettings(
  parts: {
    [K in keyof Settings]?: Settings[K] | null;
  }
) {
  const next = Settings.parse(
    Object.fromEntries(
      Object.entries({ ...readSettings(), ...parts }).filter(
        ([, v]) => v !== null
      )
    )
  );
  writeWhole(SETTINGS, next);
  read = next;
}

/** The connector's settings; only code that runs behind it (server.ts checks it is there) asks. */
export function connector() {
  const c = settings().connector;
  if (!c) {
    throw new Error("the connector is not set up (settings: connector)");
  }
  return {
    ...c,
    /** The resource's OAuth metadata. */
    metadata: `${c.origin}/.well-known/oauth-protected-resource/mcp`,
    resource: `${c.origin}/mcp`,
  };
}

const TILDE = /^~(?=\/|$)/;
/** A path from settings, `~/` expanded. */
export const expand = (path: string) => path.replace(TILDE, HOME);

/** What Life calls his agent in what it writes (reports, the board, the connector's words). */
export const agentName = () => settings().agent?.name ?? "the agent";
/** Whether his agent pulls its asks (`read_open_agent_tasks`) rather than having them pushed as the MCP event `ask`. */
export const pulls = () => settings().agent?.transport === "pull";
