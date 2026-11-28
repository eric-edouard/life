import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { writeWhole } from "./files";
import {
  AgentRole,
  Engine,
  RuntimeName,
  SourceName,
  WebSearchProviderName,
} from "./names";
import { LIFE_STATE_DIR } from "./paths";
import { HOME } from "./platform";

// What makes one install differ from another, in one file: who it serves, where its parts are, what is turned on.
// Secrets are not here: they stay in the environment (`.env` for a checkout, the app passes them to the helper). A
// part left out is off. A test run reads its own (apps/server/src/test-data/state/settings.json), never his.

export const SETTINGS = join(LIFE_STATE_DIR, "settings.json");

/** A turning light of the edge: how strong, how fast and which way it turns, and where its bright part peaks and ends (0–1 of a turn). */
const AuraLight = z
  .object({
    clockwise: z.boolean(),
    end: z.number().min(0.02).max(1),
    /** How much brighter than the state's brightness its bright part is. */
    gain: z.number().min(0).max(5),
    opacity: z.number().min(0).max(1),
    peak: z.number().min(0.01).max(0.99),
    /** One turn at speed 1. */
    seconds: z.number().min(1).max(120),
  })
  .strict()
  .refine((l) => l.peak < l.end, { message: "`peak` comes before `end`" });

/** The edge in one state: how fast its lights turn, how bright it is, its glow's width and blur, how far cream moves toward the colour, how much of the lights and of the pool show. */
const AuraState = z
  .object({
    blur: z.number().min(0).max(40),
    brightness: z.number().min(0).max(1),
    colour: z.number().min(0).max(1),
    glow: z.number().min(0).max(40),
    lights: z.number().min(0).max(1),
    pool: z.number().min(0).max(1),
    speed: z.number().min(0).max(4),
  })
  .strict();

/**
 * The edge's look as he tuned it (the halo settings, his ask of 26 Nov 2026): every value the phone's edge uses
 * (`EdgeView.swift`, whose `AuraSetting.standard` is the look when absent). Kept so a developer can make it the
 * default. Its ranges only keep the phone safe (no blur or width it cannot draw, no turn faster than a second).
 */
export const Aura = z
  .object({
    arc: AuraLight,
    /** One of the aura's ten colours, by its place (`AuraSetting.choices`). */
    colour: z.number().int().min(0).max(9),
    glowOpacity: z.number().min(0).max(1),
    lights: z.tuple([AuraLight, AuraLight]),
    /** The fine border; width 0 is none. */
    line: z
      .object({
        opacity: z.number().min(0).max(1),
        width: z.number().min(0).max(4),
      })
      .strict(),
    /** The pool of light by the field: its radius in points. */
    poolRadius: z.number().min(40).max(600),
    /** The still rings' strength: the calm one, and the working one. */
    rings: z
      .object({
        calm: z.number().min(0).max(1),
        work: z.number().min(0).max(1),
      })
      .strict(),
    states: z
      .object({
        rest: AuraState,
        speaking: AuraState,
        still: AuraState,
        working: AuraState,
      })
      .strict(),
  })
  .strict();

/** A currency's ISO code: THB, EUR. */
export const Currency = z.string().regex(/^[A-Z]{3}$/, "an ISO code: THB, EUR");

/** Who pays when not him: a project or an organization (or person) of his directory, by its ref. */
export const PayerRef = z.string().regex(/^(?:person|project):[\w.-]+$/);

/**
 * The apps he pays with (his yes of 28 Nov 2026): a payment card whose `amount` need is in an entry's currency, for its
 * payer (absent: him), shows that app (`needsShownOf`); an entry with no payer serves any payer with none of its own.
 * Never defaulted.
 */
export const PayWith = z
  .array(
    z
      .object({
        // The `app` need's own two fields (`memory/needs.ts`), which core cannot import.
        app: z
          .object({
            name: z.string().min(1).max(60),
            /** An https link into the app (a universal link), as the `app` need takes it. */
            url: z.url({ protocol: /^https$/ }),
          })
          .strict(),
        currency: Currency,
        payer: PayerRef.optional(),
      })
      .strict()
  )
  .max(20);
export type PayWith = z.infer<typeof PayWith>;

export const Settings = z
  .object({
    /** Who mails him his agents' reports: the night judges them; the arrival reader skips them, message by message. */
    agentReportSenders: z.array(z.email()).default([]),
    /** His calendar (Google's, through `gog` as `account`) that Life keeps its appointments in, marked unconfirmed (`host/appointments-calendar.ts`); the voice naming also reads its events of a recording's day (`memory/naming-day.ts`). */
    appointmentsCalendar: z
      .object({ account: z.string(), calendar: z.string() })
      .strict()
      .optional(),
    /** The edge's look he saved from the halo settings (`change_setting`); absent, the phone's default. */
    aura: Aura.optional(),
    /** The model runner for imports and historical model backfills; absent, his `engine` (`readBackfillEngine`). */
    backfillEngine: Engine.optional(),
    /**
     * The local day (`YYYY-MM-DD`) the backfill reads his history from: absent means no backfill. His pick of a range in
     * setup is the approval of that range's shown cost (`host/backfill.ts`).
     */
    backfillFrom: z.iso.date().optional(),
    /** The daily restic snapshot (`backup.ts`): its repository, and the command that prints its password. Without it, no backup. */
    backup: z
      .object({ password: z.string(), repository: z.string() })
      .strict()
      .optional(),
    /**
     * What Life may spend in a month, in billed dollars (his subscriptions don't count), changed by his word
     * (`change_setting`, his yes of 25 Nov 2026). Asked once before it is passed (a fix ask); past it, background work
     * slows, recording and answering never stop; one piece of work stops at 2% of it (`spendingStopOf`, `host/spending.ts`).
     * Absent means no amount: no stop.
     */
    budget: z.object({ monthlyUsd: z.number().positive() }).strict().optional(),
    /**
     * The connector (/mcp), its sign-in (Life's own issuer, `oauth.ts`) and the Mac link: on unless `false`. Absent, its
     * origin is this Mac's loopback (`connector`, `host/http/http.ts`).
     */
    connector: z
      .union([
        z.literal(false),
        z
          .object({
            /** Its public address (a tunnel's), where clients off this Mac reach /mcp. */
            origin: z.url(),
          })
          .strict(),
      ])
      .optional(),
    /**
     * The Mac writes a description of each photo taken from this local day on (`host/describe-photos.ts`); a local
     * model, no image leaves it. Without it, none.
     */
    describePhotos: z.object({ from: z.iso.date() }).strict().optional(),
    /**
     * The desk (`apps/server/src/desk/`): Life starts and wakes his registered agents. Absent means off: the app starts
     * no desk helper and no desk code runs. `runtimes`: per runtime, the model (and effort) a registered agent runs
     * with when it names none; none given, the runtime's own default. `defaultRuntime`: a start that names none; left
     * out, pi (`BUILT_IN_RUNTIME`: every install has it, so nothing asks for Claude or Codex).
     * `roleRuntimes`: per standing role (`AgentRole`), the runtime its agent starts on when the start names none; a role
     * left out, and every project's agent, takes `defaultRuntime` (the owner's word of 22 Nov 2026). A runtime named here
     * that can't run falls to pi (`desk/runtime-fallback.ts`).
     * `handOut`: the desk starts an agent itself on a running matter from the top of his ranking (`desk/hand-out.ts`),
     * only while fewer than `cardsWaiting` agent cards wait for him and fewer than `aDay` started on his day; absent means off.
     * `agentPostRepos`: the GitHub repos (`owner/name`) where an agent of his own Life may comment, open an issue or review
     * by itself, each post ending with `AGENT_POST_SIGNATURE` (`desk/send-guard.ts`); absent means none.
     * `agentsRepo`: his agents' git repo (an absolute path): each assignment's notes file, under `assignments/`, and each
     * agent's home, committed by the desk after each turn; absent, the notes files live under the desk's own folders and
     * nothing is committed.
     * `claudeApp`: the Claude app (an absolute path to its `.app`) his "Continue on your Mac" opens a Claude agent's session in; left out,
     * `/Applications/Claude.app`. Two Claude apps share one bundle id, so it is named by path (22 Nov 2026).
     * `webSearch`: the providers `web_search` asks, in order, for an agent of his own Life on pi (`web-search/`); one
     * whose key his environment lacks is skipped. Left out, Life's chain (`WEB_SEARCH_CHAIN`, the owner's word of 22 Nov
     * 2026).
     */
    desk: z
      .object({
        agentPostRepos: z
          .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
          .optional(),
        agentsRepo: z
          .string()
          .refine(isAbsolute, "an absolute path")
          .optional(),
        claudeApp: z.string().refine(isAbsolute, "an absolute path").optional(),
        defaultRuntime: RuntimeName.optional(),
        handOut: z
          .object({
            aDay: z.number().int().positive(),
            cardsWaiting: z.number().int().positive(),
          })
          .strict()
          .optional(),
        roleRuntimes: z.partialRecord(AgentRole, RuntimeName).optional(),
        runtimes: z
          .partialRecord(
            RuntimeName,
            z
              .object({
                effort: z.string().min(1).optional(),
                model: z.string().min(1).optional(),
              })
              .strict()
          )
          .default({}),
        webSearch: z.array(WebSearchProviderName).min(1).optional(),
      })
      .strict()
      .optional(),
    /** What he calls each device Screen Time reads, by its Biome id (`sources/screen.ts`); one left out shows its platform. */
    deviceNames: z.record(z.string().min(1), z.string().min(1)).optional(),
    /** The model runner the memory steps use: chosen at `init` (`bun life init --engine`); absent, claude (`readEngine`). */
    engine: Engine.optional(),
    /** The GitHub repos (`owner/name`) whose issues and comments the `github` source reads and a card's draft may write to: no other repo is ever asked for. */
    githubRepos: z
      .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
      .min(1)
      .max(5)
      .optional(),
    /** The chat with Life's retired bot (a chat key): its messages were Life's output, never facts. */
    lifeChat: z.string().optional(),
    /** The voice server, on loopback (Life's origin forwards `/voice` to it: never Life's own address); absent, voice's own (`VOICE_URL`), which his own Life's `/voice` forwards to too (`voiceAddressOf`); its token is voice's device token (`sources/voice-server-call.ts`), else `LIFELOG_TOKEN`. */
    lifelog: z.object({ url: z.url() }).strict().optional(),
    /** Life's own mail: its sender and the owner's address, the only recipient. Without it nothing is mailed. */
    mail: z.object({ from: z.email(), to: z.email() }).strict().optional(),
    /**
     * The language his memory is written in (asked at the first run beside his name): every prompt's `{{language}}`
     * (`models/prompt-parts.ts`). Quotes stay as said; topic tags stay English. Absent: English, as before the key.
     */
    memoryLanguage: z.string().min(1).default("English"),
    /** The calendar the episodes are projected on (`host/past-calendar.ts`): a Google one through `gog` as `account`, or without one an Apple one through the app's EventKit tool. */
    pastCalendar: z
      .object({ account: z.string().optional(), calendar: z.string() })
      .strict()
      .optional(),
    /**
     * His payments. `backend`, where they come from (`apps/server/src/payments/`): his `money` CLI; on, `read_day` and
     * `read_payments` place each payment in his day; absent (the default), Life shows none. `payWith`, the apps he pays
     * with (`PayWith`, set by his word through `change_setting`).
     */
    payments: z
      .object({
        backend: z.literal("money").optional(),
        payWith: PayWith.optional(),
      })
      .strict()
      .optional(),
    /**
     * The personal add-ons (`core/add-ons.ts`): memory layers about his relationships and himself, each off while its
     * key is absent. Each takes `{}` (its scope fields come later), except `histories`.
     */
    personal: z
      .object({
        /** The Views and Health sections of pages (`memory/page-format.ts`). */
        aboutMe: z.object({}).strict().optional(),
        /**
         * The histories (`personal/histories.ts`): each night reads the closed months from `from` (YYYY-MM) on that it has
         * not read, for whoever has a page.
         */
        histories: z
          .object({ from: z.string().regex(/^\d{4}-\d{2}$/) })
          .strict()
          .optional(),
        /** What each person is like and what repeats between them and him (`personal/personas.ts`). */
        personas: z.object({}).strict().optional(),
        /**
         * The connection and conflict reads (`memory/exchange-reads.ts`): each night asks them of the finished exchanges
         * of his two-way one-to-one chats it has no stored reply for; what is stored is read all the same.
         */
        relationshipReads: z.object({}).strict().optional(),
        /** The Between us section of the pages of people close to him (`memory/page-format.ts`). */
        relationships: z.object({}).strict().optional(),
      })
      .strict()
      .optional(),
    /** The folder holding his code repos, `~/` allowed: the git source reads nothing without it. */
    reposFolder: z.string().optional(),
    /** The sources he turned on, by name: no other is read, searched or shown. */
    sources: z.array(SourceName).default([]),
    /**
     * His to-do list, input and output (`apps/server/src/todo-list/`), and its one backend: his Apple Reminders (remctl) or
     * his Google Tasks (`gog` as `account`). On, Life acts there when he asks and reads his changes back;
     * without it (the default), nothing in Life touches either.
     */
    todoList: z
      .discriminatedUnion("backend", [
        z.object({ backend: z.literal("reminders") }).strict(),
        z
          .object({ account: z.string(), backend: z.literal("google") })
          .strict(),
      ])
      .optional(),
    /**
     * Voice's processes on this Mac (`host/voice.ts`): `speakers`, speaker recognition, on unless false; `backups`, the
     * server's daily restic snapshot into Life's backup repository (the `backup` setting), off unless true.
     */
    voice: z
      .object({
        backups: z.boolean().optional(),
        speakers: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /**
     * Shows a stored voice guess as "probably <name>" when a conversation's words are opened (`fetch`, `memory/voice-guesses.ts`),
     * for sure and likely guesses only, and nowhere else. Absent means off. His yes, with the score's numbers.
     */
    voiceGuessesShown: z.literal(true).optional(),
    /**
     * The voice naming (`memory/voice-naming.ts`): each night guesses who the voices nobody named are, for the parts of
     * long conversations recorded in person, at most 40 calls. A guess is only stored, shown nowhere, and acts on nothing.
     * Needs a Lifelog Host with `GET /speakers/voices`. Absent means off: no call is made; what is stored is read all the same.
     */
    voiceNaming: z.literal(true).optional(),
  })
  .strict();
export type Settings = z.infer<typeof Settings>;

/** The settings in `path`; a missing file is every default, a corrupt one throws (never a silent switch of engine). */
export function readSettings(path = SETTINGS): Settings {
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return Settings.parse(raw);
}

/** Whole or not at all: a reader never parses half a file (a bad one stops the watcher and the nightly). */
export function writeSettings(path: string, value: unknown) {
  writeWhole(path, `${JSON.stringify(value, null, 2)}\n`);
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
  writeSettings(SETTINGS, next);
  read = next;
}

/** His monthly amount as the file holds it now, read afresh: his `change_setting` reaches the desk without a restart. */
export const readMonthlyUsd = () => readSettings().budget?.monthlyUsd;

/**
 * The model runner the backfill's steps use, read afresh: `backfillEngine`, else his `engine`. Two names for one runner:
 * the backfill may run on another engine than the night, never on none.
 */
export const readBackfillEngine = (
  { backfillEngine, engine }: Settings = readSettings()
): Engine | undefined => backfillEngine ?? engine;

/** What his word may change through `change_setting`: the monthly amount (question 22), in billed dollars, the edge's look (`Aura`), the apps he pays with (`PayWith`, the whole list), and the day the backfill reads from (his pick, the approval of its shown cost). */
export const SettingChange = z
  .object({
    aura: Aura.optional(),
    backfillFrom: z.iso.date().optional(),
    monthlyUsd: z.number().positive().max(100_000).optional(),
    payWith: PayWith.optional(),
  })
  .strict();

/** His `change_setting`: writes what it names; the settings it changes as they now stand. */
export function changeSetting({
  aura,
  backfillFrom,
  monthlyUsd,
  payWith,
}: z.infer<typeof SettingChange>) {
  if (
    aura === undefined &&
    backfillFrom === undefined &&
    monthlyUsd === undefined &&
    payWith === undefined
  ) {
    throw new Error(
      "Not done: name `monthlyUsd`, `aura`, `payWith` or `backfillFrom`."
    );
  }
  setSettings({
    ...(aura !== undefined && { aura }),
    ...(backfillFrom !== undefined && { backfillFrom }),
    ...(monthlyUsd !== undefined && { budget: { monthlyUsd } }),
    ...(payWith !== undefined && {
      payments: { ...readSettings().payments, payWith },
    }),
  });
  return {
    aura: settings().aura,
    backfillFrom: settings().backfillFrom,
    budget: settings().budget,
    payWith: settings().payments?.payWith,
  };
}

const TILDE = /^~(?=\/|$)/;
/** A path from settings, `~/` expanded. */
export const expand = (path: string) => path.replace(TILDE, HOME);
