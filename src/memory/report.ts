import { type Health, polling } from "../health";
import { log } from "../log";
import type { Action } from "../schema";
import { type Digest, LIFE_MAIL, renderHtml, type Section } from "./email";
import type { extract } from "./extract";
import type { describeFiles } from "./files";
import type { moments } from "./moments";
import type { pages } from "./pages";
import type { mapRepos } from "./repos";
import { count, localTime, time } from "./units";
import { localDate, when } from "./zones";

// The nightly report: one HTML email (with a plain-text alternative) to the owner's own address, composed by code from the steps' summaries
// (no model). `sendReport` also carries the watcher's alerts (its feed, its public connector).

const FROM = `Claude <${LIFE_MAIL.from}>`;

type Result<T extends (...args: never[]) => Promise<unknown>> = Awaited<
  ReturnType<T>
>;

/** What a finished night produced, step by step. */
export interface Night {
  /** Life's actions of the last 24 h, and what keeps it from acting (a remctl check that failed). */
  acted: { actions: Action[]; problems: string[] };
  /** The last backup (`backupLine`). */
  backup: string;
  /** Yesterday's commits by project (repos.ts `codeRows`); empty when building them failed. */
  code: { name: string; relation: string }[];
  extracted: Result<typeof extract>;
  /** The salience-3 page lines among `observed` not retired, each with its home page's name (`page`). */
  facts: { page: string; text: string }[];
  /** The files the night read (`describeFiles`): its failed calls and missing tools never fail the night. */
  files: Result<typeof describeFiles>;
  /** The first day of the window the night read, to its own day. */
  from: string;
  /** The days whose moments were read again, and how many moments they hold. */
  moments: Result<typeof moments>;
  /** Observations that show and whose source line was first cited since the last good night (`newSince`): midday runs' included. */
  observed: number;
  paged: Result<typeof pages>;
  repos: Result<typeof mapRepos>;
  /** Observations retired since the last good night: midday runs' included. */
  retired: number;
  /** The watcher's health (`readHealth`) when the night read its store, as it stood. */
  watcher: Health | null;
}

const duration = (ms: number) =>
  `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

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
        `Verdicts agree with your labels ${percent(a.agreement)} of the time (${a.labeled} labels)`,
        `Lifelog: ${n.watcher && polling(n.watcher) ? "the watcher is polling" : `the watcher is NOT POLLING (last good poll ${n.watcher?.lastOkAt ? localTime(n.watcher.lastOkAt) : "never"}), so its store, read as it stands, may lag`}`,
        `Read ${when(n.from).date}–${date}: ${n.moments.units} units, ${count(n.moments.moments, "moment")} on ${count(n.moments.read, "day")}, ${n.extracted.read} extracted, ${n.observed} new observations since the last night, ${n.moments.people.length} people inferred`,
        `Files: ${n.files.described} described, ${n.files.read} read by code, ${n.files.copied} copied${n.files.failed > 0 ? `; ${count(n.files.failed, "call")} failed (a file still not described stays a tag until the next night)` : ""}${n.files.missing.length > 0 ? `; not on PATH: ${n.files.missing.join(", ")}` : ""}`,
        n.backup,
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
              relation: actionLine(x),
            })),
          ],
          title: "Actions",
        },
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

/** The email of a night that stopped at `step`. */
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
      "Nothing was committed; the next run resumes where this one stopped.",
      `Details: derived/log/${day}.jsonl`,
    ],
    preheader: `Stopped at ${step} after ${duration(ms)}: ${error}`.slice(
      0,
      140
    ),
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

/** The watcher's alert (`down`: no successful poll for a while) or its all-clear. */
export function watchReport(down: boolean, since: string, error: string) {
  const at = time(since);
  return alert(since, "Life watcher", {
    failure: down ? { error, step: "the lifelog feed" } : null,
    notes: [
      down
        ? "No successful poll since the time above. New chapters are not reaching the units; they catch up from the saved cursor once it polls again."
        : "Polling again from the saved cursor; nothing was lost.",
      "Details: bun life status, and ~/Library/Logs/life-watch.log",
    ],
    preheader: down
      ? `No successful poll since ${at}: ${error}`.slice(0, 140)
      : "Polling again.",
    stats: [{ label: "last ok", value: at }],
    subject: down ? "lifelog watcher is down" : "lifelog watcher is back",
    verdict: down ? "DOWN" : "OK · polling again",
  });
}

/** The public connector's alert (the tunnel did not recover) or its all-clear. */
export function publicReport(down: boolean, at: string) {
  return alert(at, "Life watcher", {
    failure: down
      ? {
          error:
            "life.ericedouard.com does not answer; restarting the tunnel did not fix it",
          step: "the public connector",
        }
      : null,
    notes: ["Details: bun life status, and ~/Library/Logs/life-watch.log"],
    preheader: down
      ? "Claude and ChatGPT cannot reach Life."
      : "Claude and ChatGPT reach Life again.",
    stats: [{ label: down ? "down since" : "back at", value: time(at) }],
    subject: down ? "public connector is down" : "public connector is back",
    verdict: down ? "DOWN" : "OK · back",
  });
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

/** The alert for an action that failed: his words are in it, so he can do the thing by hand. */
export const actionFailedReport = (a: Action) =>
  alert(a.at, "Life action", {
    failure: { error: a.error ?? "", step: `${a.kind} ${a.target}` },
    notes: [
      `You said: “${a.instruction.quote}”`,
      `Do it by hand, after a look at what is already there. Details: derived/log, memory/actions.jsonl (${a.id})`,
    ],
    preheader:
      `Could not ${a.kind} “${a.after.title ?? a.target}”: ${a.error}`.slice(
        0,
        140
      ),
    stats: [{ label: "at", value: time(a.at) }],
    subject: `could not ${a.kind}: ${a.after.title ?? a.target}`,
    verdict: "FAILED",
  });

/** One line saying what an action did and on which of his words: the nightly's Actions section and `day`. */
export function actionLine(a: Action) {
  const was = a.before?.title ?? a.target;
  const changed = Object.entries(a.after)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const what = {
    add: `“${a.after.title}”${a.after.list ? ` in ${a.after.list}` : ""}`,
    ask: `to Atlas${a.after.confidence === "low" ? " (low confidence)" : ""}`,
    done: `done “${was}”`,
    edit: a.after.title
      ? `“${was}” → “${a.after.title}”`
      : `“${was}”: ${changed}`,
    // Until 19 Oct Life also emailed Instinct; those lines stay in actions.jsonl.
    instinct: `to Instinct: “${a.after.subject}”`,
    remove: `removed “${was}”`,
  }[a.kind];
  const outcome = {
    duplicate: ` duplicate of #${a.target.split(":")[1]}`,
    failed: ` FAILED: ${a.error}`,
    ok: "",
  }[a.result];
  return `${what} ← “${a.instruction.quote}”${outcome}`;
}

export type Mail = ReturnType<typeof compose> & {
  attachments?: { content: string; filename: string }[];
};

/**
 * Sends a report with Resend's API (idempotent per `id`, `<kind>/<run or incident>`; the kind names the step in the log). A failed send is logged and returns null: it never changes
 * how the night ended.
 */
export async function sendReport(id: string, mail: Mail) {
  try {
    const key = process.env.RESEND_PERSONAL_API_KEY;
    // His address, the only recipient.
    const to = process.env.LIFE_MAIL_TO;
    if (!(key && to)) {
      throw new Error("RESEND_PERSONAL_API_KEY or LIFE_MAIL_TO is not set");
    }
    const res = await fetch("https://api.resend.com/emails", {
      body: JSON.stringify({ from: FROM, to: [to], ...mail }),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "idempotency-key": `life/${id}`,
      },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as { id?: string; message?: string };
    if (!(res.ok && body.id)) {
      throw new Error(`Resend ${res.status}: ${body.message ?? "no id"}`);
    }
    log("email.sent", { id: body.id, subject: mail.subject });
    return body.id;
  } catch (e) {
    log("run.error", {
      error: (e as Error).message,
      step: `email.${id.split("/")[0]}`,
    });
    return null;
  }
}
