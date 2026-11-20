import {
  configureSync,
  getLogger,
  type LogRecord,
  type Sink,
} from "@logtape/logtape";
import { redactByField } from "@logtape/redaction";
import { clock } from "./clock";

// A log line's shape, for Life and Voice alike, through LogTape: `time`, `level`, `category` (`[app, process, step…]`),
// `msg` (LogTape's raw template, its placeholders the line's own fields), then the fields. Pure of paths and settings,
// so Voice's server imports it without Life's (`paths.ts` needs Life's code folder); each app owns its sink.

/** The ids Life's records carry: observations, episodes, units, matters, ledger entries (`entry_`) and conversations (UUIDs). */
export const IDS =
  /\b(?:obs|ep|unit|entry|matter)_[0-9a-f]{12}\b|\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/g;

export const LOG_LEVELS = ["info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** A line's level: a refusal warns (a caller's mistake, checked first); a run error, an `error` or `ok: false` is an error. */
export const logLevelOf = (e: Record<string, unknown>): LogLevel => {
  if (e.kind === "run.error") {
    return "error";
  }
  if (e.refused) {
    return "warn";
  }
  return e.error || e.ok === false ? "error" : "info";
};

/** Who a line is about: a fixed few, as the phone lists them; a kind's prefix maps here, a run's step's first word if it is one. */
const PROCESSES = new Set([
  "archive",
  "card",
  "decision",
  "desk",
  "draft",
  "mcp",
  "memory",
  "model",
  "source",
  "watch",
]);
const PROCESS_OF: Record<string, string> = {
  calendar: "source",
  email: "memory",
  file: "model",
  lifelog: "source",
  matter: "memory",
  offline: "watch",
  photos: "model",
  quota: "model",
  sync: "watch",
};
const word = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** A line's LogTape category below `life`: its process, then its step (a run's step, a call's tool, a read's source). */
export const categoryOf = (kind: string, e: Record<string, unknown>) => {
  const [head = kind, rest] = kind.split(".");
  if (head === "run") {
    const step = (word(e.step) ?? "run").split(".");
    return PROCESSES.has(step[0] ?? "") ? step : ["memory", ...step];
  }
  const step = word(e.tool) ?? word(e.source) ?? word(e.prompt) ?? rest;
  return [PROCESS_OF[head] ?? head, ...(step ? [step] : [])];
};

/** The fields a line's message shows, in this order, each in its words: code's own words and numbers, never free text. */
const SHOWN = [
  ["what", "{what}"],
  ["op", "{op}"],
  ["phase", "{phase}"],
  ["outcome", "{outcome}"],
  ["via", "via {via}"],
  ["by", "by {by}"],
  ["options", "{options} options"],
  ["cards", "{cards} cards"],
  ["loudness", "{loudness}"],
  ["count", "{count} rows"],
  ["errorType", "failed: {errorType}"],
  ["ms", "in {ms}"],
] as const;

const KIND_JOINS = /[._]/g;
/** A line's LogTape template: its kind in words, then each shown field it has (`SHOWN`), a placeholder for its value. */
export const templateOf = (kind: string, e: Record<string, unknown>) =>
  [
    kind.replace(KIND_JOINS, " "),
    ...SHOWN.filter(([k]) => e[k] !== undefined).map(([, words]) => words),
  ].join(" ");

/** An error from a model or its provider: logged as its type only (its words can echo what was asked). */
export const fromModel = (e: unknown) => {
  if (e instanceof Error) {
    Object.assign(e, { isFromModel: true });
  }
  return e;
};
const FIRST_LINE = /[\r\n].*$/s;

const firstLineOf = (text: string) =>
  text.replace(FIRST_LINE, "").slice(0, 200);

/** An error as a line keeps it: a model's (`fromModel`) by its type only; Life's own by its message's first line, kept on the Mac. */
export const errorOf = (e: unknown) => {
  const err = e instanceof Error ? e : new Error(String(e));
  const errorType = err.name;
  return (err as { isFromModel?: boolean }).isFromModel
    ? { error: errorType, errorType }
    : { error: firstLineOf(err.message), errorType };
};

/** Fields named for content, dropped from every line at any depth: a net under the writers, which never pass them. */
const CONTENT = [
  "after",
  "answer",
  "body",
  "content",
  "note_text",
  "quote",
  "said",
  "stderr",
  "stdout",
  "text",
];

const LEVEL_WORD: Record<string, LogLevel> = {
  error: "error",
  warning: "warn",
};
/** A line: LogTape's standard fields first, then the line's own (which never override them). */
const lineOf = (r: LogRecord) => {
  // Entries, not an object literal: the formatter sorts a literal's keys.
  const standard = Object.fromEntries([
    ["time", String(r.properties.time)],
    ["level", LEVEL_WORD[r.level] ?? "info"],
    ["category", r.category],
    ["msg", r.rawMessage],
  ]);
  return JSON.stringify({ ...standard, ...r.properties, ...standard });
};

/** Where each app's lines go (`logWriter`): its own sink, so neither app's startup depends on the other's. */
const writers = new Map<string, (line: string, time: string) => void>();
const toWriter: Sink = (r) =>
  writers.get(r.category[0] ?? "")?.(lineOf(r), String(r.properties.time));

let isConfigured = false;
/** The one LogTape setup, made on the first writer a process asks for: every app's lines through one redaction. */
const configure = () => {
  if (isConfigured) {
    return;
  }
  configureSync({
    loggers: [
      { category: [], lowestLevel: "info", sinks: ["lines"] },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
    sinks: {
      lines: redactByField(toWriter, {
        action: "delete",
        fieldPatterns: CONTENT,
      }),
    },
  });
  isConfigured = true;
};

/**
 * A writer of `app`'s lines (Life's `log`, Voice's `record`): one instant per line, `time`, which `write` also gets to
 * pick its file. A field named `kind` is the line's kind; a caller's own `kind` field is kept as `fieldKind`.
 */
export const logWriter = (
  app: string,
  write: (line: string, time: string) => void
) => {
  writers.set(app, write);
  configure();
  return (kind: string, fields: Record<string, unknown> = {}) => {
    const { kind: fieldKind, ...rest } = fields;
    const e = {
      time: clock().toISOString(),
      ...rest,
      // Every writer's error text kept to one line, as `errorOf` keeps it.
      ...(typeof rest.error === "string"
        ? { error: firstLineOf(rest.error) }
        : {}),
      ...(fieldKind === undefined ? {} : { fieldKind }),
      kind,
    };
    const level = logLevelOf(e);
    getLogger([app, ...categoryOf(kind, e)])[level](templateOf(kind, e), e);
  };
};
