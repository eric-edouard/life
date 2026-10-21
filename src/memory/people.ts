import { z } from "zod";
import { INFERRED_PREFIX, type InferredPerson, type MadeBy } from "../schema";
import { digest } from "./ledger";
import { locate } from "./observe";
import { areaOf, type Built, slugOf } from "./units";
import { UNKNOWN } from "./who";

// Who the people not on the map are: what the moments call is asked about a day, and its answer checked (every quote
// must be in a unit it read). No disk, network or clock.

const ID_MAX = 40;
const SUFFIX = 6;
const TRAILING_DASH = /-+$/;
// Lifelog labels a voice it cannot name "speaker_1"; that is not a name.
const VOICE = /^speaker[_ ]?\d+$/i;

const Said = z.object({
  area: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
  evidence: z
    .array(z.object({ quote: z.string().min(1), unit: z.string() }))
    .default([]),
  key: z.string(),
  name: z.string().min(1).max(80),
  project: z.string().nullable().default(null),
  relation: z.string().min(1).max(160),
});

/** An id no other inferred person has: `inf-` and the name as a slug, with a short suffix from the key when taken. */
export function inferredId(name: string, key: string, taken: Set<string>) {
  const base = `${INFERRED_PREFIX}${slugOf(name).slice(0, ID_MAX).replace(TRAILING_DASH, "") || "person"}`;
  const id = taken.has(base) ? `${base}-${digest("sha1", key, SUFFIX)}` : base;
  taken.add(id);
  return id;
}

/**
 * Who the moments call says the day's unknown handles and names are, checked: a surface we asked about (`unknown`: the
 * units it appears in; the first answer for it), at least one quote found in the text of one of those units, an area
 * from the list and a project we know, else none. A person is recorded however unsure the model is; how far to trust
 * it is the `confidence` (the resolver uses it from INFERRED_USE_AT).
 */
export function checkPeople(
  said: unknown[],
  ctx: {
    areas: Map<string, string>;
    at: string;
    madeBy: MadeBy;
    projects: Set<string>;
    /** The text of a unit as the model read it. */
    read: (b: Built) => string;
    taken: Set<string>;
    unknown: Map<string, Built[]>;
  }
) {
  const records: InferredPerson[] = [];
  for (const raw of said) {
    const r = Said.safeParse(raw);
    const seen = r.success ? ctx.unknown.get(r.data.key) : undefined;
    if (
      !(r.success && seen) ||
      records.some((x) => x.surfaces.includes(r.data.key))
    ) {
      continue;
    }
    const evidence = r.data.evidence.flatMap((e) => {
      const b = seen.find((x) => x.unit.id === e.unit);
      const hit = b && locate(e.quote, [ctx.read(b)]);
      return hit && b ? [{ quote: hit.verbatim, unit: b.unit.id }] : [];
    });
    if (evidence.length > 0) {
      records.push({
        area: areaOf(r.data.area, ctx.areas),
        at: ctx.at,
        confidence: r.data.confidence,
        evidence,
        id: inferredId(r.data.name, r.data.key, ctx.taken),
        madeBy: ctx.madeBy,
        name: r.data.name,
        project:
          r.data.project && ctx.projects.has(r.data.project)
            ? r.data.project
            : null,
        relation: r.data.relation,
        schemaVersion: 1,
        surfaces: [r.data.key],
      });
    }
  }
  return records;
}

/**
 * The surfaces of a day not on the map, with the units they appear in: chat senders (WhatsApp, iMessage, Beeper) and
 * names lifelog gave a voice, as their units keep them (`unknown:`). `known` says which resolve now (truth, his
 * corrections, a confident inferred person).
 */
export function unknownIn(units: Built[], known: (s: string) => boolean) {
  const out = new Map<string, Built[]>();
  const add = (s: string, b: Built) => {
    if (!(known(s) || VOICE.test(s.trim()))) {
      out.set(s, [...new Set([...(out.get(s) ?? []), b])]);
    }
  };
  for (const b of units) {
    for (const p of b.unit.people) {
      if (p.startsWith(UNKNOWN)) {
        add(p.slice(UNKNOWN.length), b);
      }
    }
  }
  return out;
}
