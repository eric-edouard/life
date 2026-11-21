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

/** The ids Life's records carry: observations, episodes, units, matters, ledger entries (`entry_`), appointments and conversations (UUIDs). */
export const IDS =
  /\b(?:obs|ep|unit|entry|matter|apt)_[0-9a-f]{12}\b|\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/g;

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
  resource: "watch",
  sync: "watch",
};
const word = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** A line's LogTape category below `life`: its process, then its step (a run's step, a call's tool, a read's source). */
export const categoryOf = (kind: string, e: Record<string, unknown>) => {
  const [head = kind, rest] = kind.split(".");
  if (head === "run" && e.step === "crash") {
    // A command that crashed is its own process: `life watch` crashing is the watcher's.
    return [word(e.command) ?? "crash", "crash"];
  }
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
export const fromModel = (e: unknown) =>
  Object.assign(e instanceof Error ? e : new Error(String(e)), {
    isFromModel: true,
  });
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
 * pick its file. `kind` and `time` are the writer's: a caller's own `kind` field is kept as `fieldKind`, its `time` is overwritten.
 */
export const logWriter = (
  app: string,
  write: (line: string, time: string) => void
) => {
  writers.set(app, write);
  configure();
  return (kind: string, fields: Record<string, unknown> = {}) => {
    // The standard fields are the writer's: a caller's own `kind` or `level` is kept beside them.
    const { kind: fieldKind, level: fieldLevel, ...rest } = fields;
    const e = {
      ...rest,
      // Every writer's error text kept to one line, as `errorOf` keeps it.
      ...(typeof rest.error === "string"
        ? { error: firstLineOf(rest.error) }
        : {}),
      ...(fieldKind === undefined ? {} : { fieldKind }),
      ...(fieldLevel === undefined ? {} : { fieldLevel }),
      kind,
      time: clock().toISOString(),
    };
    const level = logLevelOf(e);
    getLogger([app, ...categoryOf(kind, e)])[level](templateOf(kind, e), e);
  };
};

// --- a line as his app is shown it (`read_log_lines`) ---------------------------------------------------------------

/** One piece of a shown line: words of the template, or a field's value formatted for display (a duration, a count, a masked id). */
export type LinePart = { text: string } | { value: string };
export interface ShownLine {
  at: string;
  category: string[];
  level: LogLevel;
  message: string;
  parts: LinePart[];
}

const MESSAGE_CHARS = 160;
const PLACEHOLDER = /\{(\w+)\}/g;
const SPACES = /\s+/g;
const masked = (text: string) => text.replace(IDS, "…").replace(SPACES, " ");

/** A field's value as shown: a duration in ms or s, anything else as its words, ids masked. */
const shownValueOf = (key: string, v: unknown) => {
  if (key === "ms" && typeof v === "number") {
    return v < 1000 ? `${v} ms` : `${Math.round(v / 1000)} s`;
  }
  return masked(typeof v === "string" ? v : JSON.stringify(v ?? null));
};

/** A template's parts with its fields' values, cut to `MESSAGE_CHARS` in all. */
export const partsOf = (template: string, e: Record<string, unknown>) => {
  const parts: LinePart[] = [];
  let left = MESSAGE_CHARS;
  const add = (as: "text" | "value", words: string) => {
    const cut = words.slice(0, left);
    if (cut) {
      parts.push(as === "text" ? { text: cut } : { value: cut });
      left -= cut.length;
    }
  };
  let at = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    add("text", masked(template.slice(at, m.index)));
    add("value", shownValueOf(m[1] ?? "", e[m[1] ?? ""]));
    at = m.index + m[0].length;
  }
  add("text", masked(template.slice(at)));
  return parts;
};

/** A refusal's class, from its text (a tool's answer, or a line written before classes): never its words. */
export const refusalClassOf = (text: string) => {
  if (text.startsWith("Invalid arguments")) {
    return "invalid_arguments";
  }
  if (text.startsWith("Not done")) {
    return "not_done";
  }
  const head = text.split(":")[0] ?? "";
  return REFUSALS.has(head) ? head : "error";
};
const REFUSALS = new Set([
  "forbidden",
  "invalid",
  "invalid_arguments",
  "not_done",
  "rejected",
]);

/** A line before LogTape in words: its kind, what it is about (a run's step whole), then why as a class only. */
const oldMessageOf = (kind: string, e: Record<string, unknown>) => {
  const about = kind.startsWith("run.")
    ? [word(e.step)]
    : categoryOf(kind, e)
        .slice(1)
        .filter((w) => w !== kind.split(".")[1]);
  const why = e.refused
    ? `refused, ${refusalClassOf(String(e.refused))}`
    : (word(e.outcome) ?? (logLevelOf(e) === "error" ? "failed" : undefined));
  return [kind, ...about, why]
    .filter(Boolean)
    .join(" ")
    .replace(PLACEHOLDER, "");
};

/**
 * A stored line as his app is shown it, or undefined when it is not one. A LogTape line (`time`, `msg`) by its
 * template and fields; a line before it (`at`, `kind`) by its kind, category and why's class, as one text part.
 */
export const shownLineOf = (
  e: Record<string, unknown>
): ShownLine | undefined => {
  const kind = word(e.kind);
  const at = word(e.time) ?? word(e.at);
  if (!(kind && at)) {
    return;
  }
  const isLogTape = Array.isArray(e.category) && typeof e.msg === "string";
  const parts = isLogTape
    ? partsOf(String(e.msg), e)
    : partsOf(oldMessageOf(kind, e), {});
  return {
    at,
    category: isLogTape
      ? (e.category as string[]).slice(1)
      : categoryOf(kind, e),
    level: (LOG_LEVELS as readonly unknown[]).includes(e.level)
      ? (e.level as LogLevel)
      : logLevelOf(e),
    message: parts.map((p) => ("text" in p ? p.text : p.value)).join(""),
    parts,
  };
};
