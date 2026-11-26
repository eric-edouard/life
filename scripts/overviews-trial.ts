// The generated-overviews trial (docs/plans/2026-11-26-generated-overviews.md), run on a copy of the data only
// (LIFE_OWNER_DATA_DIR and LIFE_STATE_DIR pointed at it). Writes nothing under memory/.
//   bun scripts/overviews-trial.ts list                 the matters to pick from
//   bun scripts/overviews-trial.ts run <picks.json> <out>  {people: [ref], matters: [id]}: one call each, in parallel,
//     checked (cites, life: links, quotes), with the live rows code would draw; out/<subject>.json
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hasAddOn } from "../apps/server/src/core/add-ons";
import { openChecksNow } from "../apps/server/src/host/inbox";
import {
  matterRowsNowOf,
  readPeopleAndOrganizations,
} from "../apps/server/src/host/matter-rows";
import { checksOnMatterOf } from "../apps/server/src/memory/checks";
import {
  contextPeopleBy,
  levelsWith,
  personallyClose,
} from "../apps/server/src/memory/closeness";
import { readEvidence } from "../apps/server/src/memory/matter-evidence";
import { laterShownOf, matterPeopleOf } from "../apps/server/src/memory/matter-read";
import { readMatterBookAndRecords } from "../apps/server/src/memory/matters";
import {
  episodesNow,
  pagePath,
  readEpisodes,
} from "../apps/server/src/memory/memory-files";
import { meContext, refContext } from "../apps/server/src/memory/model-context";
import { openById } from "../apps/server/src/memory/open-by-id";
import { locate } from "../apps/server/src/memory/quote-check";
import { oneMatter } from "../apps/server/src/memory/read-matters";
import { lifeRefsOf } from "../apps/server/src/memory/refs";
import { begin, readsOf } from "../apps/server/src/memory/run";
import {
  situationEpisodesOf,
  situationInputOf,
} from "../apps/server/src/memory/situations";
import { clip } from "../apps/server/src/memory/units";
import { readPeople } from "../apps/server/src/memory/who";
import { dayNow } from "../apps/server/src/memory/zones";
import { readHistory } from "../apps/server/src/personal/histories";
import { personaReadingsOf } from "../apps/server/src/personal/personas";

const PERSON_PROMPT = "memory-situation-markdown.v1";
const MATTER_PROMPT = "memory-matter-situation.v1";
const SHOWN_STEPS = 12;
const SHOWN_CHARS = 200;

const [mode, picksPath = "", out = ""] = process.argv.slice(2);
const people = await readPeople();
const today = dayNow();
const { book, records } = await readMatterBookAndRecords(people, today);

if (mode === "list") {
  for (const v of book) {
    console.log(
      [
        v.id,
        v.status,
        v.steps.length,
        v.openSteps.length,
        v.nextStep?.kind ?? "-",
        v.projects.join(",") || "-",
        v.steps.at(-1)?.day,
        v.name,
      ].join("\t")
    );
  }
  process.exit(0);
}

const picks = (await Bun.file(picksPath).json()) as {
  matters: string[];
  people: string[];
};
await mkdir(out, { recursive: true });

/** Every string in a value: what a quote may be found in. */
const stringsOf = (x: unknown): string[] =>
  typeof x === "string"
    ? [x]
    : Array.isArray(x)
      ? x.flatMap(stringsOf)
      : x && typeof x === "object"
        ? Object.values(x).flatMap(stringsOf)
        : [];

const QUOTED = /[“"«]([^”"»\n]{12,})[”"»]/g;
const quotesOf = (md: string) => [
  ...md.split("\n").flatMap((l) => (l.startsWith(">") ? [l.slice(1).trim()] : [])),
  ...[...md.matchAll(QUOTED)].map((m) => m[1] ?? ""),
];

/** The reply's parts, each checked as the plan says: cites and life: links among what was shown, quotes found in it. */
function checkedParts(reply: unknown, shownIds: Set<string>, input: unknown) {
  const raw = (reply as { parts?: unknown } | null)?.parts;
  const lines = stringsOf(input);
  return (Array.isArray(raw) ? raw : []).map((p) => {
    const markdown = String((p as { markdown?: unknown }).markdown ?? "");
    const cites = ((p as { cites?: unknown }).cites ?? []) as string[];
    const links = [...lifeRefsOf(markdown)];
    const quotes = quotesOf(markdown).map((q) => ({
      found: locate(q, lines) !== null,
      q,
    }));
    const problems = [
      ...(cites.length === 0 ? ["no cite"] : []),
      ...cites.filter((c) => !shownIds.has(c)).map((c) => `cite not shown: ${c}`),
      ...links.filter((c) => !shownIds.has(c)).map((c) => `link not shown: ${c}`),
      ...quotes.filter((q) => !q.found).map((q) => `quote not found: ${q.q}`),
      ...(/\]\(https?:/.test(markdown) ? ["web link"] : []),
      ...(/^#/m.test(markdown) ? ["heading"] : []),
    ];
    return { cites, kept: problems.length === 0, links, markdown, problems, quotes };
  });
}

const levels = levelsWith(people);
const refs = refContext(people, personallyClose(levels), contextPeopleBy(levels));
const all = episodesNow(await readEpisodes(), people.corrections);
const personStep = await begin("situation-trial", "main", { prompt: PERSON_PROMPT });
const matterStep = await begin("matter-situation-trial", "main", { prompt: MATTER_PROMPT });

async function person(ref: string) {
  const episodes = situationEpisodesOf(all, (m) =>
    m.people.some((p) => people.refOf(p.ref) === ref)
  );
  const file = Bun.file(pagePath(ref));
  const text = (await file.exists()) ? await file.text() : "";
  const persona = hasAddOn("personas") ? personaReadingsOf(ref, today) : [];
  const story = hasAddOn("histories") ? readHistory(ref).story : null;
  const digested = situationInputOf(episodes, people.nameOf, text, persona);
  const input = {
    episodes: digested.episodes,
    page: { ref, text },
    ...(hasAddOn("personas") ? { persona } : {}),
    ...(story ? { story: { ref: `${ref}/story`, text: story.text } } : {}),
    today,
  };
  const started = performance.now();
  const reply = await personStep.ask({
    context: refs.context,
    dir: join(personStep.dir, ref.replace(/\W/g, "_")),
    input,
    prompt: PERSON_PROMPT,
    reads: readsOf([
      { source: "memory", unit: ref },
      ...episodes.map((m) => ({ source: "memory" as const, unit: m.id })),
    ]),
  });
  const ms = Math.round(performance.now() - started);
  const shown = new Set([ref, `${ref}/story`, ...episodes.map((m) => m.id)]);
  const now = (await openById(`${ref}/now`, undefined, undefined, readPeopleAndOrganizations)) as Record<string, unknown>;
  return {
    inputChars: JSON.stringify(input).length + JSON.stringify(refs.context).length,
    kind: "person",
    live: {
      checks: now.checks ?? [],
      line: now.line,
      name: now.name ?? people.nameOf(ref),
      needsYou: now.needsYou,
      open: now.open ?? [],
      reach: now.reach ?? [],
    },
    ms,
    newestEpisode: episodes.at(-1)?.day,
    episodes: episodes.length,
    parts: checkedParts(reply, shown, input),
    reply,
    ref,
    story: Boolean(story),
  };
}

async function matter(id: string) {
  const v = book.find((m) => m.id === id);
  if (!v) {
    throw new Error(`no matter ${id}`);
  }
  const later = laterShownOf(v, records.observations, records.refOf);
  const evidence = (await readEvidence([{ later, v }], today)).get(v.id) ?? {
    payments: [],
    units: [],
  };
  const steps = v.steps.slice(-SHOWN_STEPS);
  const input = {
    matter: {
      ...(v.goal ? { goal: v.goal.text } : {}),
      later: later.map((o) => ({
        day: o.date,
        id: o.id,
        kind: o.type,
        said_by: o.speaker === "person:me" ? "me" : people.nameOf(o.speaker),
        text: clip(o.text, SHOWN_CHARS),
      })),
      name: v.name,
      open: v.openSteps.map((s) => ({
        id: s.ref,
        kind: s.kind,
        text: clip(s.text, SHOWN_CHARS),
        ...(s.when ? { due: s.when } : {}),
      })),
      people: matterPeopleOf(v).map(people.nameOf),
      projects: v.projects,
      steps: steps.map((s) => ({
        day: s.day,
        id: s.ref,
        kind: s.kind,
        text: clip(s.text, SHOWN_CHARS),
        ...(s.ending ? { ended: true } : {}),
      })),
      today,
      units: evidence.units,
    },
  };
  const started = performance.now();
  const reply = await matterStep.ask({
    context: meContext(people.truth),
    dir: join(matterStep.dir, id),
    input,
    prompt: MATTER_PROMPT,
    reads: readsOf([
      ...[...steps.map((s) => s.ref), ...v.openSteps.map((s) => s.ref), ...later.map((o) => o.id)].map(
        (unit) => ({ source: "memory" as const, unit })
      ),
      ...evidence.units.map((u) => ({ source: u.source, unit: u.id })),
    ]),
  });
  const ms = Math.round(performance.now() - started);
  const shown = new Set([
    ...steps.map((s) => s.ref),
    ...v.openSteps.map((s) => s.ref),
    ...later.map((o) => o.id),
    ...evidence.units.map((u) => u.id),
  ]);
  const row = await oneMatter([id], { book });
  const open = await openChecksNow();
  const [live] = row ? matterRowsNowOf([row], open) : [];
  return {
    inputChars: JSON.stringify(input).length,
    kind: "matter",
    live: {
      checks: checksOnMatterOf(open, id),
      name: v.name,
      needsYou: live?.needsYou,
      nextStep: live?.nextStep,
      status: v.status,
    },
    ms,
    parts: checkedParts(reply, shown, input),
    reply,
    ref: id,
    steps: v.steps.length,
  };
}

const jobs = [
  ...picks.people.map((r) => ({ id: r, run: () => person(r) })),
  ...picks.matters.map((m) => ({ id: m, run: () => matter(m) })),
];
const results = await Promise.allSettled(
  jobs.map(async (j) => {
    const r = await j.run();
    await Bun.write(join(out, `${j.id.replace(/\W/g, "_")}.json`), JSON.stringify(r, null, 1));
    return r;
  })
);
for (const [i, r] of results.entries()) {
  console.log(jobs[i]?.id, r.status, r.status === "rejected" ? String(r.reason) : `${r.value.ms} ms`);
}
console.log(JSON.stringify({ matter: matterStep.end({}), person: personStep.end({}) }));
