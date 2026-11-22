import { daysBefore } from "../core/clock";
import { DAY_RECORD_READ, DayRecord } from "../records/read-reply";
import type { MatterView } from "./matter-read";
import { readMatterBook } from "./matters";
import { episodesWhere, READ_REPLIES, readLedger } from "./memory-files";
import {
  type DayParts,
  dayLines,
  readDayParts,
  readDayRecord,
} from "./read-day";
import { projectOf } from "./read-matters";
import { makeReplies, READS } from "./read-replies";
import { begin, inputsOf, readsOf, type Step } from "./run";
import { type People, readPeople } from "./who";
import { dayStart } from "./zones";

// The day records (docs/glossary.md): one model call per closed day, the night after it, writing what the day was —
// its headline, its summary, who took part and in what role, the projects it moved, where he was and what continued
// from the days before. Stored by `memory/read-replies.ts` as one more read (`DAY_RECORD_READ`), shown first by
// `read_day`; the night asks a day again only when its evidence changed (`inputsOf` over refs only, never a name).

const { prompt: PROMPT } = READS.day_record;

/** The weekday of a date, in English (`Monday`), from its UTC noon: no zone of the Mac's to leak into a day. */
const weekdayOf = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "long",
  });

/** The most steps of one matter a day's input shows: the rest of the day is in its lines. */
const STEPS_SHOWN = 6;

/**
 * What one day's record call is shown and the digest of what it rests on: the day's lines (its episodes, its
 * conversation summaries, the facts in no episode and its payments), the matters the day moved grouped by their
 * project's name, and `earlier` (the records of the days before, added by the caller). The digest holds ids only —
 * the episodes, the facts, the summaries, the payments, and each moved matter with its day's step refs — so a rename
 * re-reads nothing.
 */
export function dayRecordInputOf(
  day: string,
  parts: DayParts,
  book: readonly MatterView[],
  truth: Pick<People["truth"], "projects">
) {
  const moved = book.flatMap((m) => {
    const steps = m.steps.filter((s) => s.day === day);
    return steps.length > 0 ? [{ matter: m, steps }] : [];
  });
  const groups = new Map<
    string | null,
    { matters: { name: string; steps: string[] }[]; project: string | null }
  >();
  for (const { matter, steps } of moved) {
    const project = projectOf(truth)(matter)?.name ?? null;
    const group = groups.get(project) ?? { matters: [], project };
    group.matters.push({
      name: matter.name,
      steps: steps.map((s) => s.text).slice(0, STEPS_SHOWN),
    });
    groups.set(project, group);
  }
  return {
    digest: inputsOf(PROMPT, {
      episodes: parts.refs.episodes,
      facts: parts.refs.facts,
      matters: moved.map(({ matter, steps }) => ({
        id: matter.id,
        steps: steps.map((s) => s.ref),
      })),
      payments: parts.refs.payments,
      summaries: parts.refs.summaries,
    }),
    input: {
      day,
      day_lines: dayLines({
        done: parts.done,
        episodes: parts.episodes,
        facts: parts.facts,
        payments: parts.payments,
        summaries: parts.summaries,
      }).join("\n"),
      projects: [...groups.values()],
      weekday: weekdayOf(day),
    },
  };
}

/**
 * The night's day records: each closed day of `days`, oldest first, read once and asked when its digest changed. A day
 * with no episode is skipped, and so is one whose stored record holds the same digest. Each day is one call, stored
 * before the next reads its record as `earlier`, so a failed day is simply absent from the days after it. A failure
 * costs that day only.
 */
export async function dayRecords(
  days: string[],
  step?: Step,
  where = READ_REPLIES
) {
  const run =
    step ?? (await begin("day-records", "main", { prompts: [PROMPT] }));
  const people = await readPeople();
  const all = await episodesWhere(() => true);
  const ledger = readLedger();
  const book = await readMatterBook(people, days.at(-1) ?? "");
  let [calls, stored] = [0, 0];
  for (const day of days.toSorted()) {
    // biome-ignore lint/performance/noAwaitInLoops: one day per call, so the next day reads this one's record as `earlier`
    const parts = await readDayParts(day, { all, ledger, people });
    // The index is built earlier in the night; a run without it records nothing and says so.
    if (typeof parts === "string") {
      throw new Error(parts);
    }
    const episodes = all.filter((e) => e.day === day);
    if (episodes.length === 0) {
      continue;
    }
    const { digest, input } = dayRecordInputOf(day, parts, book, people.truth);
    if (readDayRecord(day, where)?.inputs === digest) {
      continue;
    }
    const earlier = [1, 2, 3].flatMap((n) => {
      const held = readDayRecord(daysBefore(day, n), where);
      return held
        ? [
            {
              day: held.day,
              summary: held.reply.summary,
              weekday: weekdayOf(held.day),
            },
          ]
        : [];
    });
    const made = await makeReplies(
      [
        {
          at: dayStart(day).toISOString(),
          call: {
            checked: (r) => DayRecord.parse(r),
            day,
            firstAt: dayStart(day).toISOString(),
            input: { ...input, earlier },
            inputs: digest,
            keys: episodes.map((e) => e.id),
            reads: readsOf(
              episodes.flatMap((e) =>
                e.units.map((unit) => ({ source: "memory" as const, unit }))
              )
            ),
            starts: [0],
          },
          read: DAY_RECORD_READ,
        },
      ],
      run,
      where
    );
    calls += 1;
    stored += made.stored;
  }
  return run.end({ calls, stored });
}
