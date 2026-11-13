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

const NON_WORD = /\W+/g;
/**
 * Life's own wake ("hey Life", `hear.ts`), shaped like an agent's: it marks what he says next for Life to keep and wakes
 * no agent. "live" is how lifelog wrote it on 21 Oct (audit 4).
 */
export const LIFE_WAKE = { misheard: ["live"], wake: ["life"] };
/** A wake word as heard, compared: lower case, one space between words. */
export const asHeard = (w: string) =>
  w.toLowerCase().replace(NON_WORD, " ").trim();

export const Settings = z
  .object({
    /**
     * His agents by name (what Life calls each): the words that wake it ("hey <word>", `hear.ts`) and how lifelog
     * mishears them (a misheard wake counts only on his own turn, as low confidence). An agent is known on the
     * connector by its pairing (`bun life pair <agent>`) and pulls its asks (`read_agent_asks`). Without one nothing
     * wakes an agent. `onAsk`, when set, is the agent's own command, started (detached, no argument) once per new ask.
     */
    agents: z
      .record(
        z.string().min(1),
        z
          .object({
            misheard: z.array(z.string()).default([]),
            onAsk: z.array(z.string()).min(1).optional(),
            wake: z.array(z.string()).min(1),
          })
          .strict()
      )
      .refine(
        (agents) => {
          const words = [LIFE_WAKE, ...Object.values(agents)].flatMap((a) => [
            ...new Set([...a.wake, ...a.misheard].map(asHeard)),
          ]);
          return new Set(words).size === words.length;
        },
        {
          message:
            "two agents, or an agent and Life, share a wake or misheard word",
        }
      )
      .optional(),
    /** His calendar (Google's, through `gog` as `account`) that Life keeps its appointments in, marked unconfirmed (`host/appointments-calendar.ts`). */
    appointments: z
      .object({ account: z.string(), calendar: z.string() })
      .strict()
      .optional(),
    /** The model runner for imports and historical model backfills; absent means off. */
    backfillEngine: Engine.optional(),
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
     * The Mac writes a description of each photo taken from this local day on (`host/describe-photos.ts`); a local
     * model, no image leaves it. Without it, none.
     */
    describePhotos: z.object({ from: z.iso.date() }).strict().optional(),
    /** What he calls each device Screen Time reads, by its Biome id (`sources/screen.ts`); one left out shows its platform. */
    devices: z.record(z.string().min(1), z.string().min(1)).optional(),
    /** The model runner the memory steps use. */
    engine: Engine.default("claude"),
    /**
     * The exchange reads (`memory/exchange-reads.ts`): each night asks the three reads of the finished exchanges of
     * his living one-to-one chats it has no stored reply for. Absent means off: no call is made; what is stored is
     * read all the same.
     */
    exchangeReads: z.literal(true).optional(),
    /**
     * The histories (`memory/histories.ts`): each night reads the closed months from `from` (YYYY-MM) on that it has
     * not read, for whoever has a page. Absent means off: no month is read.
     */
    history: z
      .object({ from: z.string().regex(/^\d{4}-\d{2}$/) })
      .strict()
      .optional(),
    /** The chat with Life's retired bot (a chat key): its messages were Life's output, never facts. */
    lifeChat: z.string().optional(),
    /** lifelog's server; its token is `LIFELOG_TOKEN`. */
    lifelog: z.object({ url: z.url() }).strict().optional(),
    /**
     * The links (`memory/links.ts`): each night reads how the open things between him and a person ended. Absent
     * means off: nothing is read. Nothing reads the links yet.
     */
    links: z.literal(true).optional(),
    /** Life's own mail: its sender and the owner's address, the only recipient. Without it nothing is mailed. */
    mail: z.object({ from: z.email(), to: z.email() }).strict().optional(),
    /** The calendar the episodes are projected on (`host/past-calendar.ts`): a Google one through `gog` as `account`, or without one an Apple one through the app's EventKit tool. */
    past: z
      .object({ account: z.string().optional(), calendar: z.string() })
      .strict()
      .optional(),
    /**
     * Where his payments come from (`apps/server/src/payments/`): his `money` CLI. On, `read_day` and `read_payments`
     * place each payment in his day; off (the default), Life shows none.
     */
    payments: z
      .object({ backend: z.literal("money") })
      .strict()
      .optional(),
    /** Who mails him his agents' reports: their mail is judged, not dropped as `not-a-person`. */
    reports: z.array(z.email()).default([]),
    /** The folder holding his code repos, `~/` allowed: the git source reads nothing without it. */
    repos: z.string().optional(),
    /** The sources he turned on, by name: no other is read, searched or shown. */
    sources: z.array(SourceName).default([]),
    /**
     * His to-do list, input and output (`apps/server/src/todo-list/`), and its one backend: his Apple Reminders (remctl) or
     * his Google Tasks (`gog` as `account`). On, Life acts there when he asks and reads his changes back;
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

/** His agents' names, in the settings' order. */
export const agentNames = () => Object.keys(settings().agents ?? {});
