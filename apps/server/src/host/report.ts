import { join } from "node:path";
import { clock, MIN, unfrozen } from "../core/clock";
import { digest } from "../core/hash";
import { log, recentEvents } from "../core/log";
import { LIFE_STATE_DIR } from "../core/paths";
import { notifyArgs } from "../core/platform";
import { execOk } from "../core/proc";
import { agentName, pulls, settings } from "../core/settings";
import {
  type Digest,
  LIFE_MAIL,
  renderHtml,
  type Section,
} from "../memory/email";
import type { extract } from "../memory/extract";
import type { Task } from "../memory/ledger";
import type { describeFiles } from "../memory/message-files";
import type { moments } from "../memory/moments";
import type { pages } from "../memory/pages";
import type { mapRepos } from "../memory/repos";
import { enabledSources, listening } from "../memory/sources";
import { count, localTime, time } from "../memory/units";
import { localDate, when } from "../memory/zones";
import type { LedgerEntry } from "../records/ledger-entry";
import { entryLine } from "../todo-list/items";
import { type Health, polling } from "./health";

// The nightly report: one HTML email (with a plain-text alternative) to the owner's own address, composed by code from the steps' summaries
// (no model). `sendReport` also carries the alerts (a failed action or delivery, an agent task that needs him, the lock, the archive).

const FROM = `Claude <${LIFE_MAIL.from}>`;

type Result<T extends (...args: never[]) => Promise<unknown>> = Awaited<
  ReturnType<T>
>;

/** What a finished night produced, step by step. */
export interface Night {
  /** Life's actions of the last 24 h, and what keeps it from acting (a remctl check that failed). */
  acted: {
    actions: LedgerEntry[];
    problems: string[];
    tasks: { name: string; relation: string }[];
  };
  /** The archive's failures since the last night (`archiveLine`). */
  archive: string;
  /** The last backup (`backupLine`). */
  backup: string;
  /** Yesterday's commits by project (repos.ts `codeRows`); empty when building them failed. */
  code: { name: string; relation: string }[];
  extracted: Result<typeof extract>;
  /** The importance-3 page lines among `observed` not retired, each with its observation (`id`) and its home page's name (`page`). */
  facts: { id: string; page: string; text: string }[];
  /** The files the night read (`describeFiles`): its failed calls and missing tools never fail the night. */
  files: Result<typeof describeFiles>;
  /** The first day of the window the night read, to its own day. */
  from: string;
  /** Each unit holding one of his asks, read since the last night, and what the memory holds of it (`whatIsNew`). */
  marked: { name: string; relation: string }[];
  /** The days whose moments were read again, and how many moments they hold. */
  moments: Result<typeof moments>;
  /** Observations that show and whose source line was first cited since the last good night (`newSince`): midday runs' included. */
  observed: number;
  paged: Result<typeof pages>;
  /** His engine's quota as the night ended (`quotaLine`), when it has one. */
  quota?: string;
  repos: Result<typeof mapRepos>;
  /** Observations retired since the last good night: midday runs' included. */
  retired: number;
  /** What the model calls of the last 24 h spent, a line per run and per sweep's step (`spent`, nightly.ts). */
  spent: string[];
  /** The watcher's health (`readHealth`) when the night read its store, as it stood. */
  watcher: Health | null;
}

export const duration = (ms: number) =>
  `${Math.floor(ms / MIN)}m ${Math.round((ms % MIN) / 1000)}s`;

const percent = (x: number | null) =>
  x === null ? "-" : `${Math.round(x * 100)}%`;

/** One row of a section as text. */
function textLine(s: Section) {
  switch (s.kind) {
    case "facts":
      return s.list.map((f) => `- ${f.text} [${f.page}]`);
    case "changes":
      return s.list.map(
        (c) =>
          `- ${c.page}: +${c.added} added, ${c.moved} moved to History, ${c.removed} removed`
      );
    default:
      return s.list.map((p) => `- ${p.name}: ${p.relation}`);
  }
}

/** The text of a digest: the HTML's plain alternative. */
function text(d: Digest) {
  return [
    `${LIFE_MAIL.subject}${d.date} · ${d.verdict}`,
    d.models ?? "",
    "",
    ...(d.failure ? [d.failure.error, ""] : []),
    d.stats.map((s) => `${s.value} ${s.label}`).join(" · "),
    "",
    ...(d.sections ?? []).flatMap((s) =>
      s.list.length > 0
        ? [`${s.title} (${s.list.length})`, ...textLine(s), ""]
        : []
    ),
    ...d.notes,
  ].join("\n");
}

const compose = (subject: string, d: Digest) => ({
  html: renderHtml(d),
  subject: `${LIFE_MAIL.subject}${subject}`,
  text: text(d),
});

/** What the night says of the watcher: off with no voice source, else polling or not. */
function watcherLine(h: Night["watcher"]) {
  if (!listening()) {
    return "no voice source";
  }
  if (h && polling(h)) {
    return "the watcher is polling";
  }
  return `the watcher is NOT POLLING (last good poll ${h?.lastOkAt ? localTime(h.lastOkAt) : "never"}), so its store, read as it stands, may lag`;
}

/** The email of a night that committed. */
export function successReport(day: string, ms: number, n: Night) {
  const { date, weekday } = when(day);
  const { changes } = n.paged;
  const { actions: done, problems } = n.acted;
  const a = n.moments.agreement;
  const models = [
    ...new Set([n.moments, n.extracted, n.paged].map((s) => s.model)),
  ].join(", ");
  const mail = compose(
    `${date} · ${count(n.facts.length, "new fact")}, ${count(changes.length, "page")}${done.length > 0 ? `, ${count(done.length, "action")}` : ""}`,
    {
      date,
      failure: null,
      models,
      notes: [
        `Corrections applied: ${n.paged.corrections}; observations retired: ${n.retired}`,
        ...(n.paged.dropped.length > 0
          ? [
              `Pages no longer kept (git has them): ${n.paged.dropped.join(", ")}`,
            ]
          : []),
        `Verdicts agree with your labels ${percent(a.agreement)} of the time (${a.labeled} labels)`,
        `Sources on: ${
          enabledSources()
            .map((s) => s.label)
            .join(", ") || "none (turn one on to start)"
        }`,
        `Lifelog: ${watcherLine(n.watcher)}`,
        `Read ${when(n.from).date}–${date}: ${n.moments.units} units, ${count(n.moments.moments, "moment")} on ${count(n.moments.read, "day")}, ${n.extracted.read} extracted, ${n.observed} new observations since the last night, ${n.moments.people.length} people inferred`,
        `Files: ${n.files.described} described, ${n.files.read} read by code, ${n.files.copied} copied${n.files.failed > 0 ? `; ${count(n.files.failed, "call")} failed (a file still not described stays a tag until the next night)` : ""}${n.files.missing.length > 0 ? `; not on PATH: ${n.files.missing.join(", ")}` : ""}`,
        n.archive,
        n.backup,
        ...(n.quota ? [n.quota] : []),
        ...n.spent,
        "Failures: none",
      ],
      preheader: `${count(n.facts.length, "new fact")} on ${count(changes.length, "page")}, ${count(n.moments.people.length, "new person")}. Verdicts agree ${percent(a.agreement)}.`,
      sections: [
        {
          kind: "pairs",
          list: [
            ...problems.map((relation) => ({ name: "Problem", relation })),
            ...done.map((x) => ({
              name: `${time(x.at)} · ${x.kind}`,
              relation: entryLine(x),
            })),
          ],
          title: "Actions",
        },
        { kind: "pairs", list: n.acted.tasks, title: `${agentName()} tasks` },
        {
          kind: "pairs",
          list: [
            ...n.code,
            ...n.repos.suggestions.map((s) => ({
              name: "New repo",
              relation: `${s.repo} → ${s.area ?? "no area"} · new project? ${s.newProject}`,
            })),
          ],
          title: "Code yesterday",
        },
        { kind: "pairs", list: n.marked, title: "Asks remembered" },
        { kind: "facts", list: n.facts, title: "What it found" },
        { kind: "pairs", list: n.moments.people, title: "New people" },
        { kind: "changes", list: changes, title: "What changed" },
      ],
      stats: [
        { label: "new facts", value: String(n.facts.length) },
        { label: "pages changed", value: String(changes.length) },
        { label: "people inferred", value: String(n.moments.people.length) },
        { label: "agreement", value: percent(a.agreement) },
        { label: "duration", value: duration(ms) },
        { label: "units read", value: String(n.moments.units) },
      ],
      verdict: "OK · memory committed",
      weekday,
    }
  );
  // Large bodies can be clipped by mail clients; the attachment always has every row.
  return {
    ...mail,
    attachments: [
      {
        content: Buffer.from(mail.html).toString("base64"),
        filename: `life-${day}.html`,
      },
    ],
  };
}

/** The email of a run (a night, a midday, a backfill) that stopped at `step` and will not try again. */
export function failureReport(
  day: string,
  ms: number,
  step: string,
  error: string
) {
  const { date, weekday } = when(day);
  return compose(`${date} · failed at ${step}`, {
    date,
    failure: { error, step },
    notes: [
      "Nothing was committed.",
      `Details: derived/log/${clock().toISOString().slice(0, 10)}.jsonl`,
    ],
    preheader: `Stopped at ${step} after ${duration(ms)}: ${error}`,
    stats: [
      { label: "stopped at", value: step },
      { label: "after", value: duration(ms) },
    ],
    verdict: `FAILED at ${step}`,
    weekday,
  });
}

/** An alert email: one failure box (or an all-clear) and a few notes, none of the nightly's digest. */
function alert(
  at: string,
  label: string,
  a: Pick<Digest, "failure" | "notes" | "preheader" | "stats" | "verdict"> & {
    subject: string;
  }
) {
  const { date, weekday } = when(localDate(at));
  const { subject, ...rest } = a;
  return compose(subject, { date, label, weekday, ...rest });
}

/** The nightly's alert: a run has held the lock over 3 hours, so no night or midday can start. */
export const lockReport = (since: string) =>
  alert(since, "Life nightly", {
    failure: {
      error: "a run has held the lock for over 3 hours",
      step: "the lock",
    },
    notes: [
      "No night or midday starts while it holds it. Details: derived/log, and the pid in ~/Life/.nightly.lock",
    ],
    preheader: `A run has held the lock since ${time(since)}.`,
    stats: [{ label: "held since", value: time(since) }],
    subject: "a run is stuck holding the lock",
    verdict: "STUCK",
  });

/** The alert for the agent tasks that newly need him, one per `chase` pass (apps/server/src/host/agent.ts): why, and his words. */
export function taskReport(
  list: { ask: Task["ask"]; cause: string; title: string }[],
  now: number
) {
  const why = list.map((x) => `${x.title}: ${x.cause}`).join(" · ");
  return alert(new Date(now).toISOString(), `${agentName()} tasks`, {
    failure: { error: why, step: `${agentName()} tasks` },
    notes: [
      ...list.map(
        (x) =>
          `${x.title}: you said “${x.ask.instruction.quote}” (asked ${time(x.ask.at)}, ${x.ask.id})`
      ),
      "Each is a task on the agent's board (memory/ledger.jsonl).",
    ],
    preheader: why,
    stats: [{ label: "need you", value: String(list.length) }],
    subject: `${agentName()}: ${list.map((x) => `${x.title} (${x.cause.split(":")[0]})`).join(", ")}`,
    verdict: "NEEDS YOU",
  });
}

/** The alert for a lapsed `ask` subscription: about the agent, not one task. */
export const lapseReport = (open: number, now: number) =>
  alert(new Date(now).toISOString(), agentName(), {
    failure: {
      error: pulls()
        ? "no tasks call from it in a day"
        : "no live subscription to `ask`",
      step: "delivery",
    },
    notes: [
      `${open} open tasks wait, and new asks are recorded but reach ${agentName()} only once it reads them again.`,
    ],
    preheader: `${agentName()} isn't receiving asks: ${open} open tasks`,
    stats: [{ label: "open tasks", value: String(open) }],
    subject: `${agentName()} isn't receiving asks`,
    verdict: "NEEDS YOU",
  });

/** The alert for an action that failed: his words are in it, so he can do the thing by hand. */
export const actFailedReport = (a: LedgerEntry) =>
  alert(a.at, "Life action", {
    failure: { error: a.error ?? "", step: `${a.kind} ${a.target}` },
    notes: [
      `You said: “${a.instruction?.quote}”`,
      `Do it by hand, after a look at what is already there. Details: derived/log, memory/ledger.jsonl (${a.id})`,
    ],
    preheader: `Could not ${a.kind} “${a.after.title ?? a.target}”: ${a.error}`,
    stats: [{ label: "at", value: time(a.at) }],
    subject: `could not ${a.kind}: ${a.after.title ?? a.target}`,
    verdict: "FAILED",
  });

/** The alert for a store the archive has failed to copy for an hour: what is deleted meanwhile is not kept. */
export const archiveFailedReport = (
  name: string,
  since: string,
  error: string
) =>
  alert(since, "Life archive", {
    failure: { error, step: `archive ${name}` },
    notes: [
      "Messages deleted and note versions replaced meanwhile are lost until it copies again. Details: ~/Library/Logs/life-archive.log, derived/log",
    ],
    preheader: `The archive has not copied ${name} since ${time(since)}: ${error}`,
    stats: [{ label: "failing since", value: time(since) }],
    subject: `the archive cannot copy ${name}`,
    verdict: "FAILING",
  });
export type Mail = ReturnType<typeof compose> & {
  attachments?: { content: string; filename: string }[];
};

let sent: Set<string> | undefined;
/** The keys among `keys` not sent yet: the `email.sent` log of the last 8 days, read once per process. */
export async function unsent(keys: string[]) {
  sent ??= new Set(
    (await recentEvents<{ key: string }>(8, "email.sent")).map((e) => e.key)
  );
  return keys.filter((k) => !sent?.has(k));
}

/** A failed delivery is logged as a run error of step `email.<kind>` (`sendReport`). */
export const EMAIL_STEP = "email.";

/** Where reports are mailed (the `mail` setting); none: they are kept on the Mac. */
export const mailedTo = () => settings().mail?.to;

/** The nightly report's key for the night run `run` (`sendReport`): the status snapshot knows the report went by it. */
export const reportKey = (run: string) => `nightly/${run}`;

/**
 * Delivers a report once per key (`<kind>/<run or incident>`; the kind names the step in the log): by mail when the
 * `mail` setting is there, else on the Mac (`onMac`). Skipped when every key went out already (`unsent`), one
 * `email.sent` line per new key, whichever way it went. A failed delivery is logged and returns null: it never changes
 * how the night ended, and the caller may try again.
 */
export async function sendReport(id: string | string[], mail: Mail) {
  unfrozen("send email");
  const keys = await unsent([id].flat());
  if (keys.length === 0) {
    return null;
  }
  try {
    const to = mailedTo();
    const sentAs = await (to ? byMail(keys, mail, to) : onMac(keys, mail));
    for (const k of keys) {
      log("email.sent", { id: sentAs, key: k, subject: mail.subject });
      sent?.add(k);
    }
    return sentAs;
  } catch (e) {
    log("run.error", {
      error: (e as Error).message,
      step: `${EMAIL_STEP}${keys[0]?.split("/")[0]}`,
    });
    return null;
  }
}

/** Where reports kept on the Mac go: one page each, the app's to open. */
export const REPORTS = join(LIFE_STATE_DIR, "reports");

/** A report kept as a page in the state's reports/ (the app shows it) and announced by a notification: no account, no address. Its id is its file. */
async function onMac(keys: string[], mail: Mail) {
  const file = join(REPORTS, `${keys[0]?.replaceAll("/", "-")}.html`);
  await Bun.write(file, mail.html);
  const notify = notifyArgs(mail.subject, mail.text.split("\n")[0] ?? "");
  if (notify) {
    await execOk(notify);
  }
  return file;
}

/** A report mailed with Resend's API to his address; its idempotency key covers a retry of the same keys. */
async function byMail(keys: string[], mail: Mail, to: string) {
  const key = process.env.RESEND_PERSONAL_API_KEY;
  if (!key) {
    throw new Error("RESEND_PERSONAL_API_KEY is not set");
  }
  const res = await fetch("https://api.resend.com/emails", {
    body: JSON.stringify({ from: FROM, to: [to], ...mail }),
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": `life/${digest("sha256", keys.join(" "), 32)}`,
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { id?: string; message?: string };
  if (!(res.ok && body.id)) {
    throw new Error(`Resend ${res.status}: ${body.message ?? "no id"}`);
  }
  return body.id;
}
