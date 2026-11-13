import { z } from "zod";
import { digest } from "../core/hash";
import type { MadeBy } from "../records/fields";
import { INFERRED_PREFIX, type InferredPerson } from "../records/observation";
import { slugOf } from "./page-format";
import { locate } from "./quote-check";
import { kindOf } from "./sources";
import { areaOf } from "./tags";
import { type Built, UNKNOWN } from "./units";

// Who the people not in the directory are: what the episodes call is asked about a day, and its answer checked (every quote
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
  person: z.string().nullable().default(null),
  project: z.string().nullable().default(null),
  relation: z.string().min(1).max(160),
});

/** An id no other inferred person has: `inf_` and the name as a slug, with a short suffix from the key when taken. */
export function inferredId(name: string, key: string, taken: Set<string>) {
  const base = `${INFERRED_PREFIX}${slugOf(name).slice(0, ID_MAX).replace(TRAILING_DASH, "") || "person"}`;
  const id = taken.has(base) ? `${base}-${digest("sha1", key, SUFFIX)}` : base;
  taken.add(id);
  return id;
}

/**
 * Who the episodes call says the day's unknown handles and names are, checked: a surface we asked about (`unknown`: the
 * units it appears in; the first answer for it), at least one quote found in the text of one of those units, an area
 * from the list and a project we know, else none; `person` only when it is someone in truth/. A person is recorded
 * however unsure the model is; how far to trust it is the `confidence` (`foldsOf` uses it from INFERRED_USE_AT).
 */
export function checkPeople(
  said: unknown[],
  ctx: {
    areas: Map<string, string>;
    at: string;
    madeBy: MadeBy;
    projects: Set<string>;
    taken: Set<string>;
    /** The refs of the people in truth/. */
    truth: Set<string>;
    unknown: Map<string, Built[]>;
  }
) {
  const records: InferredPerson[] = [];
  for (const raw of said) {
    const r = Said.safeParse(raw);
    const seen = r.success ? ctx.unknown.get(r.data.key) : undefined;
    if (
      !(r.success && seen) ||
      records.some((x) => x.namesAndHandles.includes(r.data.key))
    ) {
      continue;
    }
    const evidence = r.data.evidence.flatMap((e) => {
      const b = seen.find((x) => x.unit.id === e.unit);
      const hit = b && locate(e.quote, [b.text]);
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
        namesAndHandles: [r.data.key],
        // Only someone in truth/: a link never leads to another guess.
        person:
          r.data.person && ctx.truth.has(r.data.person) ? r.data.person : null,
        project:
          r.data.project && ctx.projects.has(r.data.project)
            ? r.data.project
            : null,
        relation: r.data.relation,
        schemaVersion: 1,
      });
    }
  }
  return records;
}

/**
 * Whether a surface has its answer and is not asked about: it reads as someone in truth/ (or as his word says), or as an
 * inferred guess the call judged against the directory (`person` null or a ref). A guess made before the call could link
 * (`person` absent) is asked once more.
 */
export function answeredBy(
  resolve: (s: string) => string | null,
  inferred: InferredPerson[]
) {
  const judged = new Set(
    inferred.flatMap((p) => (p.person === undefined ? [] : p.namesAndHandles))
  );
  return (s: string) => {
    const ref = resolve(s);
    return (
      ref !== null &&
      (!ref.startsWith(`person:${INFERRED_PREFIX}`) || judged.has(s))
    );
  };
}

/**
 * The namesAndHandles of a day not in the directory, with the units they appear in: chat senders (WhatsApp, iMessage, the bridged networks) and
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
    // Only where people speak for themselves: mail senders are organisations and lists.
    const kind = kindOf(b.unit.source);
    for (const p of kind === "chat" || kind === "voice" ? b.unit.people : []) {
      if (p.startsWith(UNKNOWN)) {
        add(p.slice(UNKNOWN.length), b);
      }
    }
  }
  return out;
}
