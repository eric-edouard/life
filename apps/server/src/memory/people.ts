import { z } from "zod";
import { digest } from "../core/hash";
import type { MadeBy } from "../records/fields";
import {
  INFERRED_PREFIX,
  type InferredPerson,
  isSettled,
} from "../records/observation";
import { slugOf } from "./page-format";
import { locate } from "./quote-check";
import { kindOf } from "./sources";
import { areaOf } from "./tags";
import { type Built, nameKey, UNKNOWN } from "./units";
import { keysOf } from "./who";

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
  isOrganization: z.boolean().default(false),
  key: z.string(),
  name: z.string().min(1).max(80),
  otherForms: z.array(z.string().min(1)).default([]),
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
 * Who the episodes call says the day's names and handles are, checked, one record per person with every form of the name
 * it wrote (`key`, then `otherForms`). An entry for a name or handle we asked about (`unknown`: the units it appears in)
 * needs a quote found in one of those units; one for a name the lines write that we did not ask about (volunteered) needs
 * a quote in one of the day's units that holds the name, and is kept only when it is linked or settled (`isSettled`).
 * An area is from the list and a project one we know, else none; `person` is any ref of the call's map (`people`), never
 * the key's own earlier reading (`resolve`). A person is recorded however unsure the model is; how far to trust it is
 * the `confidence` (`foldsOf` uses it from INFERRED_USE_AT).
 */
export function checkPeople(
  said: unknown[],
  ctx: {
    areas: Map<string, string>;
    at: string;
    madeBy: MadeBy;
    /** The refs of the people the call was shown (the directory, inferred ones too). */
    people: Set<string>;
    projects: Set<string>;
    /** What a name as written reads as now (`readPeople`). */
    resolve: (nameOrHandle: string) => string | null;
    taken: Set<string>;
    unknown: Map<string, Built[]>;
    /** The day's units as the call saw them. */
    units: Built[];
  }
) {
  const records: InferredPerson[] = [];
  for (const raw of said) {
    const r = Said.safeParse(raw);
    if (!r.success) {
      continue;
    }
    const forms = [r.data.key, ...r.data.otherForms];
    if (records.some((x) => forms.some((f) => x.namesAndHandles.includes(f)))) {
      continue;
    }
    const seen = ctx.unknown.get(r.data.key);
    const evidence = r.data.evidence.flatMap((e) => {
      const b = (seen ?? ctx.units).find((x) => x.unit.id === e.unit);
      const hit = b && locate(e.quote, [b.text]);
      return hit &&
        b &&
        (seen || nameKey(hit.verbatim).includes(nameKey(r.data.key)))
        ? [{ quote: hit.verbatim, unit: b.unit.id }]
        : [];
    });
    const person =
      r.data.person &&
      ctx.people.has(r.data.person) &&
      r.data.person !== ctx.resolve(r.data.key)
        ? r.data.person
        : null;
    const record = {
      area: areaOf(r.data.area, ctx.areas),
      at: ctx.at,
      confidence: r.data.confidence,
      evidence,
      id: inferredId(r.data.name, r.data.key, ctx.taken),
      isOrganization: r.data.isOrganization,
      madeBy: ctx.madeBy,
      name: r.data.name,
      namesAndHandles: [...new Set(forms)],
      person,
      project:
        r.data.project && ctx.projects.has(r.data.project)
          ? r.data.project
          : null,
      relation: r.data.relation,
      schemaVersion: 1 as const,
    };
    if (evidence.length > 0 && (seen || person || isSettled(record))) {
      records.push(record);
    }
  }
  return records;
}

/** The keys of the names and handles a v9 call judged (`isOrganization` written). */
const judgedKeysOf = (inferred: InferredPerson[]) =>
  new Set(
    inferred.flatMap((p) =>
      p.isOrganization === undefined ? [] : p.namesAndHandles.flatMap(keysOf)
    )
  );

/** The ref of Life's earlier guess a name or handle reads as, else undefined: shown to the call as `earlier`, never an answer. */
export const earlierGuessOf = (ref: string | null) =>
  ref?.startsWith(`person:${INFERRED_PREFIX}`) ? ref : undefined;

/**
 * The older guesses whose evidence is in these units and that no v9 call judged yet: each one's first name or handle with
 * the units, to be asked again with the day's `unknown`. A guess made for a name the text writes (not a sender) has
 * no other way back to a call.
 */
export function oldGuessesIn(units: Built[], inferred: InferredPerson[]) {
  const judged = judgedKeysOf(inferred);
  const out = new Map<string, Built[]>();
  for (const p of inferred) {
    const [key] = p.namesAndHandles;
    const seen = units.filter((b) =>
      p.evidence.some((e) => e.unit === b.unit.id)
    );
    if (
      key &&
      p.isOrganization === undefined &&
      seen.length > 0 &&
      !keysOf(key).some((k) => judged.has(k))
    ) {
      out.set(key, [...new Set([...(out.get(key) ?? []), ...seen])]);
    }
  }
  return out;
}

/**
 * Whether a name or handle has its answer and is not asked about: it reads as someone in truth/ (or as his word says), or as an
 * inferred guess judged by the v9 call (`isOrganization` written, `person` null or a ref). An older guess is asked once more.
 */
export function answeredBy(
  resolve: (s: string) => string | null,
  inferred: InferredPerson[]
) {
  const judged = judgedKeysOf(inferred);
  return (s: string) => {
    const ref = resolve(s);
    return (
      ref !== null &&
      (!ref.startsWith(`person:${INFERRED_PREFIX}`) ||
        keysOf(s).some((k) => judged.has(k)))
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
