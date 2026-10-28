// `bun scripts/eval.ts <facts.json> [claims.jsonl] | --ratings | --judge-cases <cases.json> [--json]`: grades what Life's memory holds about a few days against facts
// checked by hand (~/Life/docs/evals/). Claims default to what the memory holds today of the facts' window (`claimsNow`, the words the owner rates);
// a candidate pipeline passes its own as JSON lines `{id, date, text}`. `--ratings` grades the statements the owner rated
// (memory/ratings.jsonl) and records the score (memory/scores.jsonl). A judge model (main tier) grades each fact.
// `--json` prints the counts alone, for the bench (scripts/bench.ts). `--judge-cases` measures the judge itself: cases
// whose grade the owner settled (~/Life/docs/evals/judge-cases-*.json), each judged alone, and how many it gets right.

import { join } from "node:path";
import { clock } from "@life/server/src/core/clock";
import { appendJsonl } from "@life/server/src/core/files";
import {
  liveUnits,
  OUT,
  ratedFacts,
  readUnits,
  SCORES,
} from "@life/server/src/memory/ledger";
import { locked } from "@life/server/src/memory/memory-lock";
import { chunks, ended, inBatches, metered } from "@life/server/src/memory/run";
import { spareQuota } from "@life/server/src/memory/schedule";
import { type Claim, claimsNow } from "@life/server/src/memory/statements";
import {
  GRADES,
  type Grade,
  judge,
  tally,
} from "@life/server/src/memory/tally";
import { llmFor, llmSpec } from "@life/server/src/models/llm";
import { EvalScore } from "@life/server/src/records/statement";
import { z } from "zod";

const ClaimLine = z.object({
  date: z.string(),
  id: z.string(),
  text: z.string(),
});
const Facts = z.object({
  facts: z.array(
    z.object({
      // The day the fact is judged as of (a state true then), when it has one; `source` says where its truth comes from.
      date: z.iso.date().optional(),
      fact: z.string(),
      id: z.string(),
      source: z.string().optional(),
      true: z.boolean(),
    })
  ),
  from: z.iso.date(),
  to: z.iso.date(),
});
/** Cases whose grade the owner settled: the judge must give `expect` for `fact` against these `claims`. */
const JudgeCases = z.object({
  cases: z.array(
    z.object({
      claims: z.array(ClaimLine),
      date: z.iso.date().optional(),
      expect: z.enum(GRADES),
      fact: z.string(),
      id: z.string(),
      why: z.string(),
    })
  ),
});
/** The claims `keep` keeps, as the judge reads them. */
const lines = (claims: Claim[], keep: (c: Claim) => boolean) =>
  claims.flatMap((c) =>
    keep(c) ? [{ date: c.date, id: c.ref, text: c.text }] : []
  );

/** Rated statements per judge call. */
const PER_CALL = 30;

/**
 * `--ratings`: the statements he rated true or false, judged against what the memory holds now of the same units, 30
 * at a time, all under the lock (one snapshot; the score is saved or the run fails). A false hides only its own claim
 * id, so a re-read that says it again is restated; a true still held is its own claim, so for trues the score says
 * whether they survived. An outdated one (true then, retired by his answer) is a true one held, not judged (`tally`). A statement none of whose units exist any more (a conversation regrouped) can't be judged: it is
 * listed apart and left out of the score.
 */
async function ratedRun() {
  const [claims, units] = await Promise.all([claimsNow(), readUnits()]);
  const live = liveUnits(units);
  const rated = ratedFacts();
  const { gone = [], judged = [] } = Object.groupBy(rated, (f) =>
    f.units.some((u) => live.has(u)) ? "judged" : "gone"
  );
  const grades: Grade[] = [];
  // By date, so a batch of 30 holds few dates: the judge makes one call per date.
  const asked = judged
    .filter((f) => !f.outdated)
    .toSorted((a, b) => a.date.localeCompare(b.date));
  await inBatches(chunks(asked, PER_CALL), DIR, async (part, dir) => {
    const near = new Set(part.flatMap((f) => f.units));
    const seen = lines(claims, (c) => c.units.some((u) => near.has(u)));
    grades.push(...(await judge(part, seen, { dir, run })));
  });
  const t = tally(judged, grades);
  if (judged.length > 0) {
    await appendJsonl(SCORES, EvalScore, [
      {
        ...t.counts,
        at: clock().toISOString(),
        gone: gone.length,
        rated: judged.length,
        run,
        schemaVersion: 1,
      },
    ]);
  }
  return {
    facts: judged,
    note: gone.map((f) => `- units gone, not judged: ${f.id} ${f.fact}`),
    t,
    title: `${judged.length} rated statements, against the claims of their units (score in memory/scores.jsonl)`,
  };
}

/** `--judge-cases <file>`: each case judged alone against its own claims, and whether the judge gave its grade. */
async function judgeCasesRun(path: string) {
  const { cases } = JudgeCases.parse(await Bun.file(path).json());
  const got = await Promise.all(
    cases.map(
      async (c) =>
        (await judge([c], c.claims, { dir: join(DIR, c.id), run }))[0]
    )
  );
  const agreed = cases.filter((c, i) => got[i]?.grade === c.expect).length;
  console.log(
    [
      `Judge ${llmSpec(llmFor("main"))}: ${agreed}/${cases.length} cases graded as the owner settled.`,
      "",
      "| case | expected | judge | why it should | judge's why |",
      "|---|---|---|---|---|",
      ...cases.map(
        (c, i) =>
          `| ${c.id} | ${c.expect} | ${got[i]?.grade ?? "-"} | ${c.why} | ${got[i]?.why ?? ""} |`
      ),
    ].join("\n")
  );
  return { agreed, cases: cases.length };
}

/** `<facts.json> [claims.jsonl]`: hand-checked facts against the window's claims, or a candidate pipeline's. */
async function factsRun(factsPath: string, claimsPath?: string) {
  const { facts, from, to } = Facts.parse(await Bun.file(factsPath).json());
  const claims = claimsPath
    ? (await Bun.file(claimsPath).text())
        .split("\n")
        .filter(Boolean)
        .map((l) => ClaimLine.parse(JSON.parse(l)))
    : lines(await claimsNow(), (c) => c.date >= from && c.date <= to);
  return {
    facts,
    note: [],
    t: tally(facts, await judge(facts, claims, { dir: DIR, run })),
    title: `${claims.length} claims, ${from} to ${to}`,
  };
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const [mode, claimsFile] = args.filter((a) => a !== "--json");
if (!mode) {
  throw new Error(
    "usage: bun scripts/eval.ts <facts.json> [claims.jsonl] | --ratings | --judge-cases <cases.json>"
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
await ended(rec, async () => {
  if (mode === "--judge-cases") {
    if (!claimsFile) {
      throw new Error("usage: bun scripts/eval.ts --judge-cases <cases.json>");
    }
    return await judgeCasesRun(claimsFile);
  }
  const result =
    mode === "--ratings"
      ? await locked(ratedRun)
      : await factsRun(mode, claimsFile);
  if (!result) {
    throw new Error("a run holds the lock: score when it is done");
  }
  const { t } = result;
  const rows = result.facts.map((f) => {
    const g = t.grades.get(f.id);
    return `| ${f.id} | ${f.true ? "true" : "false"} | ${g?.grade ?? "-"} | ${t.marks.get(f.id)} | ${g?.claims.join(" ") ?? ""} | ${g?.why ?? ""} |`;
  });
  console.log(
    asJson
      ? JSON.stringify({ ...t.counts, judge: llmSpec(llmFor("main")) })
      : [
          `${result.title}: ${t.counts.held}/${t.counts.trues} true facts held, ${t.counts.missed} missed, ${t.counts.contradicted} contradicted, ${t.counts.restated} false ones restated, ${t.counts.both} kept both (stated and contradicted), ${t.counts.ungraded} ungraded, ${t.counts.outdated} outdated (held, but Life never closed them).`,
          ...result.note,
          "",
          "| fact | is | memory | result | claims | why |",
          "|---|---|---|---|---|---|",
          ...rows,
        ].join("\n")
  );
  return t.counts;
});
