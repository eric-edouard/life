// `bun scripts/eval.ts <facts.json> [memory-lines.jsonl] | --fact-check-answers | --judge-cases <cases.json> [--json]`: grades what Life's memory holds about a few days against facts
// checked by hand (~/Life/docs/evals/). Memory lines default to what the memory holds today of the facts' window (`memoryLinesNow`, the words he answers fact checks on);
// a candidate pipeline passes its own as JSON lines `{id, date, text}`. `--fact-check-answers` grades the fact checks the owner answered
// (memory/fact-check-answers.jsonl) and records the score (memory/scores.jsonl). A judge model (judge tier) grades each fact.
// `--json` prints the counts alone, for the bench (scripts/bench.ts). `--judge-cases` measures the judge itself: cases
// whose grade the owner settled (~/Life/docs/evals/judge-cases-*.json), each judged alone, and how many it gets right.

import { join } from "node:path";
import { clock } from "@life/server/src/core/clock";
import { appendJsonl, readJson, writeJson } from "@life/server/src/core/files";
import {
  type MemoryLine,
  memoryLinesNow,
} from "@life/server/src/memory/doubts";
import {
  answeredFactChecks,
  OUT,
  readLiveUnits,
  SCORES,
} from "@life/server/src/memory/memory-files";
import { locked } from "@life/server/src/memory/memory-lock";
import { chunks, ended, inBatches, metered } from "@life/server/src/memory/run";
import { spareQuota } from "@life/server/src/memory/schedule";
import {
  asOf,
  GRADES,
  type Grade,
  isGradeKept,
  JudgeMemoryLine,
  judge,
  judgedBy,
  type KeptGrade,
  tally,
} from "@life/server/src/memory/tally";
import { llmFor, llmSpec } from "@life/server/src/models/llm";
import { EvalScore } from "@life/server/src/records/fact-check";
import { z } from "zod";

const Facts = z.object({
  facts: z.array(
    z.object({
      // The day the fact is judged as of (a state true then), when it has one.
      date: z.iso.date().optional(),
      fact: z.string(),
      id: z.string(),
      true: z.boolean(),
    })
  ),
  from: z.iso.date(),
  to: z.iso.date(),
});
/** Cases whose grade the owner settled: the judge must give `expect` for `fact` against these `memory lines`. */
const JudgeCases = z.object({
  cases: z.array(
    z.object({
      date: z.iso.date().optional(),
      expect: z.enum(GRADES),
      fact: z.string(),
      id: z.string(),
      memoryLines: z.array(JudgeMemoryLine),
      why: z.string(),
    })
  ),
});
/** The memory lines `keep` keeps, as the judge reads them. */
const lines = (memoryLines: MemoryLine[], keep: (c: MemoryLine) => boolean) =>
  memoryLines.flatMap((c) =>
    keep(c) ? [{ date: c.date, id: c.ref, text: c.text }] : []
  );

/** Answered fact checks per judge call. */
const PER_CALL = 30;
/** The `--fact-check-answers` grades kept between runs, by fact id: derived, a lost file means one full run. */
const GRADES_KEPT = join(OUT, "fact-check-grades.json");

/**
 * `--fact-check-answers`: the fact checks he answered true or false, judged against what the memory holds now of the same units, 30
 * at a time, all under the lock (one snapshot; the score is saved or the run fails). A false hides only its own memory line
 * id, so a re-read that says it again is restated; a true still held is its own memory line, so for trues the score says
 * whether they survived. An outdated one (true then, retired by his answer) is a true one held, not judged (`tally`). A fact check none of whose units exist any more (a conversation regrouped) can't be judged: it is
 * listed apart and left out of the score. A grade is kept (`GRADES_KEPT`) while its key (the fact, the memory lines on its
 * units as of its day, the judge) holds and every memory line it cites says the same (a batch also shows its other facts'
 * memory lines, which a grade may rest on); only the rest are judged again.
 */
async function factCheckAnswersRun() {
  const [memoryLines, live] = await Promise.all([
    memoryLinesNow(),
    readLiveUnits(),
  ]);
  const answered = answeredFactChecks();
  const { gone = [], judged = [] } = Object.groupBy(answered, (f) =>
    f.units.some((u) => live.has(u)) ? "judged" : "gone"
  );
  const onUnit = Map.groupBy(
    memoryLines.flatMap((c) => c.units.map((u) => ({ c, u }))),
    (x) => x.u
  );
  const memoryLinesOn = (units: string[]) =>
    lines(
      [...new Set(units.flatMap((u) => onUnit.get(u)?.map((x) => x.c) ?? []))],
      () => true
    ).toSorted((a, b) => a.id.localeCompare(b.id));
  const said = new Map(memoryLines.map((c) => [c.ref, c.text]));
  const by = judgedBy();
  const keyOf = (f: (typeof judged)[number]) =>
    String(
      Bun.hash(
        JSON.stringify([
          by,
          f.fact,
          asOf([f], memoryLinesOn(f.units))[0]?.memoryLines,
        ])
      )
    );
  const before = readJson<Record<string, KeptGrade>>(GRADES_KEPT) ?? {};
  const kept: Record<string, KeptGrade> = {};
  const keys = new Map<string, string>();
  for (const f of judged.filter((r) => !r.outdated)) {
    const k = before[f.id];
    const key = keyOf(f);
    keys.set(f.id, key);
    if (k && isGradeKept(k, key, said)) {
      kept[f.id] = k;
    }
  }
  // By date, so a batch of 30 holds few dates: the judge makes one call per date.
  const asked = judged
    .filter((f) => keys.has(f.id) && !kept[f.id])
    .toSorted((a, b) => a.date.localeCompare(b.date));
  await inBatches(chunks(asked, PER_CALL), JUDGING, async (part, dir) => {
    const seen = memoryLinesOn(part.flatMap((f) => f.units));
    for (const grade of await judge(part, seen, { dir, run })) {
      const key = keys.get(grade.fact);
      if (key) {
        kept[grade.fact] = {
          cited: grade.memoryLines.map((id) => [id, said.get(id) ?? null]),
          grade,
          key,
        };
      }
    }
    // Each batch's grades saved at once, so a later failed batch costs only its own calls.
    writeJson(GRADES_KEPT, kept);
  });
  // Again at the end: a run that asked nothing still drops the grades of fact checks gone.
  writeJson(GRADES_KEPT, kept);
  const t = tally(
    judged,
    Object.values(kept).map((k) => k.grade)
  );
  if (judged.length > 0) {
    await appendJsonl(SCORES, EvalScore, [
      {
        ...t.counts,
        answered: judged.length,
        at: clock().toISOString(),
        gone: gone.length,
        run,
        schemaVersion: 1,
      },
    ]);
  }
  return {
    facts: judged,
    note: gone.map((f) => `- units gone, not judged: ${f.id} ${f.fact}`),
    t,
    title: `${judged.length} answered fact checks, against the memory lines of their units (score in memory/scores.jsonl)`,
  };
}

/** `--judge-cases <file>`: each case judged alone against its own memory lines, and whether the judge gave its grade. */
async function judgeCasesRun(path: string) {
  const { cases } = JudgeCases.parse(await Bun.file(path).json());
  const got = new Map<string, Grade>();
  await inBatches(cases, JUDGING, async (c, dir) => {
    const [g] = await judge([c], c.memoryLines, { dir, run });
    if (g) {
      got.set(c.id, g);
    }
  });
  const agreed = cases.filter((c) => got.get(c.id)?.grade === c.expect).length;
  console.log(
    [
      `Judge ${judgedBy()}: ${agreed}/${cases.length} cases graded as the owner settled.`,
      "",
      "| case | expected | judge | why it should | judge's why |",
      "|---|---|---|---|---|",
      ...cases.map(
        (c) =>
          `| ${c.id} | ${c.expect} | ${got.get(c.id)?.grade ?? "-"} | ${c.why} | ${got.get(c.id)?.why ?? ""} |`
      ),
    ].join("\n")
  );
  return { agreed, cases: cases.length };
}

/** `<facts.json> [memory-lines.jsonl]`: hand-checked facts against the window's memory lines, or a candidate pipeline's. */
async function factsRun(factsPath: string, memoryLinesPath?: string) {
  const { facts, from, to } = Facts.parse(await Bun.file(factsPath).json());
  const memoryLines = memoryLinesPath
    ? (await Bun.file(memoryLinesPath).text())
        .split("\n")
        .filter(Boolean)
        .map((l) => JudgeMemoryLine.parse(JSON.parse(l)))
    : lines(await memoryLinesNow(), (c) => c.date >= from && c.date <= to);
  return {
    facts,
    note: [],
    t: tally(facts, await judge(facts, memoryLines, { dir: DIR, run })),
    title: `${memoryLines.length} memory lines, ${from} to ${to}`,
  };
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const [mode, memoryLinesFile] = args.filter((a) => a !== "--json");
if (!mode) {
  throw new Error(
    "usage: bun scripts/eval.ts <facts.json> [memory-lines.jsonl] | --fact-check-answers | --judge-cases <cases.json>"
  );
}
// The bench (`--json`) checked before it started: its grading is the cheap end of a run already paid for.
if (!asJson) {
  await spareQuota();
}
// A metered run: what the judge's calls spent of his Codex plan is in its `use`.
const rec = await metered("eval", { args });
const { run } = rec;
const DIR = join(OUT, "evals", run);
// The judge's calls, as `inBatches` runs them: in this run's folder, as many at once as its engine takes.
const JUDGING = { dir: DIR, llm: llmFor("judge") };
await ended(rec, async () => {
  if (mode === "--judge-cases") {
    if (!memoryLinesFile) {
      throw new Error("usage: bun scripts/eval.ts --judge-cases <cases.json>");
    }
    return await judgeCasesRun(memoryLinesFile);
  }
  const result =
    mode === "--fact-check-answers"
      ? await locked(factCheckAnswersRun)
      : await factsRun(mode, memoryLinesFile);
  if (!result) {
    throw new Error("a run holds the lock: score when it is done");
  }
  const { t } = result;
  const rows = result.facts.map((f) => {
    const g = t.grades.get(f.id);
    return `| ${f.id} | ${f.true ? "true" : "false"} | ${g?.grade ?? "-"} | ${t.marks.get(f.id)} | ${g?.memoryLines.join(" ") ?? ""} | ${g?.why ?? ""} |`;
  });
  console.log(
    asJson
      ? JSON.stringify({ ...t.counts, judge: llmSpec(llmFor("judge")) })
      : [
          `${result.title}: ${t.counts.held}/${t.counts.trues} true facts held, ${t.counts.missed} missed, ${t.counts.contradicted} contradicted, ${t.counts.restated} false ones restated, ${t.counts.both} kept both (stated and contradicted), ${t.counts.ungraded} ungraded, ${t.counts.outdated} outdated (held, but Life never closed them).`,
          ...result.note,
          "",
          "| fact | is | memory | result | memory lines | why |",
          "|---|---|---|---|---|---|",
          ...rows,
        ].join("\n")
  );
  return t.counts;
});
