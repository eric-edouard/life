// `bun scripts/timeline.ts <truth.json> [--json]`: the timeline score. The episodes memory holds now for a truth file's
// days (~/Life/docs/evals/truth-*.json), against its hand-checked timeline, by code, no model. A truth episode is found
// by a Life episode sharing its evidence units while overlapping its time, one to one (most shared units, then most
// overlap, first); one whose only matches went to other truth episodes is merged (two things read as one). A Life
// episode in the window that matches no truth episode is extra (what the truth's `notEpisodes` describe), one that matches
// but lost to another is a duplicate. For each found: start and end within 15 min, and the stay its span covers most within 150 m of the truth's
// `gps`. Stays are lifelog's (read live, like the Past calendar).

import { MIN } from "@life/server/src/core/clock";
import { episodesNow, readEpisodes } from "@life/server/src/memory/ledger";
import { edgeTime, span } from "@life/server/src/memory/past-events";
import { stayOf } from "@life/server/src/memory/places";
import { dayRange, daysBefore } from "@life/server/src/memory/units";
import { readPeople } from "@life/server/src/memory/who";
import { type Episode, LocalTime } from "@life/server/src/records/episode";
import { type Stay, visits } from "@life/server/src/sources/lifelog";
import { z } from "zod";

export const TruthSet = z.object({
  from: z.iso.date(),
  timeline: z.array(
    z.object({
      end: LocalTime.nullable(),
      evidence: z.array(z.string()),
      /** `lat,lon`, where he was, when the truth knows it. */
      gps: z.string().nullable(),
      id: z.string(),
      start: LocalTime.nullable(),
      title: z.string(),
    })
  ),
  to: z.iso.date(),
});
type TruthSet = z.infer<typeof TruthSet>;

const NEAR_MIN = 15;
const NEAR_M = 150;
const UNIT = /unit_[0-9a-f]{12}/g;

/** A span's edges in ms. */
function timed(m: Pick<Episode, "day" | "end" | "start">) {
  const s = span(m);
  return { ...s, a: edgeTime(s.allDay, s.from), b: edgeTime(s.allDay, s.to) };
}

/** Metres from a point to a stay (haversine); no stay is infinitely far. */
function metresTo(lat1: number, lon1: number, s: Stay | undefined) {
  if (!s) {
    return Number.POSITIVE_INFINITY;
  }
  const [lat2, lon2] = [s.latitude, s.longitude];
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Minutes between two edges when both are timed, else undefined. */
const offBy = (a: string | null, b: string | null, x: number, y: number) =>
  a?.includes(" ") && b?.includes(" ")
    ? Math.round(Math.abs(x - y) / MIN)
    : undefined;

export function timelineScore(
  truth: TruthSet,
  episodes: Episode[],
  stays: Stay[]
) {
  const [from, to] = [
    edgeTime(true, truth.from),
    edgeTime(true, daysBefore(truth.to, -1)),
  ];
  const life = episodes
    .map((m) => ({ m, ...timed(m) }))
    .filter((l) => l.a < to && l.b > from);
  // Every (truth, Life) pair sharing a unit while overlapping, best first; each side is matched at most once.
  const pairs = truth.timeline
    .flatMap((t) => {
      const units = new Set(t.evidence.flatMap((e) => e.match(UNIT) ?? []));
      const tt = timed({ day: truth.from, end: t.end, start: t.start });
      return life.flatMap((l) => {
        const shared = l.m.units.filter((u) => units.has(u)).length;
        return shared > 0 && l.a < tt.b && l.b > tt.a
          ? [
              {
                l,
                overlap: Math.min(l.b, tt.b) - Math.max(l.a, tt.a),
                shared,
                t,
                tt,
              },
            ]
          : [];
      });
    })
    .toSorted((x, y) => y.shared - x.shared || y.overlap - x.overlap);
  const match = new Map<string, (typeof pairs)[number]>();
  const taken = new Set<string>();
  for (const p of pairs) {
    if (!(match.has(p.t.id) || taken.has(p.l.m.id))) {
      match.set(p.t.id, p);
      taken.add(p.l.m.id);
    }
  }
  const touched = new Set(pairs.map((p) => p.l.m.id));
  const rows = truth.timeline.map((t) => {
    const p = match.get(t.id);
    if (!p) {
      // Merged: only a Life episode matched to another truth episode holds it (two things read as one).
      const into = pairs.find((q) => q.t.id === t.id)?.l.m;
      return { id: t.id, into, title: t.title };
    }
    const { l, tt } = p;
    const [lat, lon] = t.gps?.split(",").map(Number) ?? [];
    const located = lat !== undefined && lon !== undefined;
    return {
      endOff: offBy(t.end, l.m.end, tt.b, l.b),
      episode: l.m,
      id: t.id,
      placeOff: located
        ? Math.round(
            metresTo(
              lat,
              lon,
              stayOf(
                new Date(l.a).toISOString(),
                new Date(l.b).toISOString(),
                stays
              )
            )
          )
        : undefined,
      startOff: offBy(t.start, l.m.start, tt.a, l.a),
      title: t.title,
    };
  });
  const near = (k: "endOff" | "placeOff" | "startOff", within: number) => {
    const checked = rows.flatMap((r) => (r[k] === undefined ? [] : [r[k]]));
    return {
      checked: checked.length,
      ok: checked.filter((v) => v <= within).length,
    };
  };
  const extra = life.filter((l) => !touched.has(l.m.id)).map((l) => l.m);
  const merged = rows.filter((r) => r.into).length;
  return {
    counts: {
      // A Life episode sharing a truth episode's evidence but matched to none: the same thing read twice.
      duplicates: touched.size - taken.size,
      end: near("endOff", NEAR_MIN),
      extra: extra.length,
      found: match.size,
      merged,
      missed: rows.length - match.size - merged,
      place: near("placeOff", NEAR_M),
      start: near("startOff", NEAR_MIN),
      truth: rows.length,
    },
    extra,
    rows,
  };
}

type Score = ReturnType<typeof timelineScore>;

function show(v: number | undefined, unit: string) {
  if (v === undefined) {
    return "";
  }
  return v === Number.POSITIVE_INFINITY ? "no stay" : `${v} ${unit}`;
}

/** A truth episode's row: its Life episode and how far off it is, or what became of it. */
function cells(r: Score["rows"][number]) {
  if (r.episode) {
    return `${r.episode.id} ${r.episode.title} | ${show(r.startOff, "min")} | ${show(r.endOff, "min")} | ${show(r.placeOff, "m")}`;
  }
  return `${r.into ? `merged into ${r.into.id}` : "missed"} | | |`;
}

export const timelineLine = ({ counts: c }: Score) =>
  `${c.found}/${c.truth} found, ${c.merged} merged into another, ${c.missed} missed, ${c.extra} extra, ${c.duplicates} duplicates; start within ${NEAR_MIN} min ${c.start.ok}/${c.start.checked}, end ${c.end.ok}/${c.end.checked}, place within ${NEAR_M} m ${c.place.ok}/${c.place.checked}`;

export const timelineTable = (s: Score, truth: TruthSet) =>
  [
    `Timeline ${truth.from}${truth.to === truth.from ? "" : ` to ${truth.to}`}: ${timelineLine(s)}.`,
    "",
    "| truth | Life episode | start off | end off | place off |",
    "|---|---|---|---|---|",
    ...s.rows.map((r) => `| ${r.id} | ${cells(r)} |`),
    "",
    "Extra (in the window, matching no truth episode):",
    ...s.extra.map((m) => `- ${m.id} ${m.start ?? m.day} ${m.title}`),
  ].join("\n");

if (import.meta.main) {
  const [file] = process.argv.slice(2).filter((a) => a !== "--json");
  if (!file) {
    throw new Error("usage: bun scripts/timeline.ts <truth.json> [--json]");
  }
  const truth = TruthSet.parse(await Bun.file(file).json());
  const [lines, people, stays] = await Promise.all([
    readEpisodes(),
    readPeople(),
    visits(dayRange(truth.from, truth.to)),
  ]);
  const s = timelineScore(truth, episodesNow(lines, people.corrections), stays);
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(s.counts)
      : timelineTable(s, truth)
  );
}
