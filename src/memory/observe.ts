import { z } from "zod";
import {
  type MadeBy,
  MemoryType,
  Modality,
  type Observation,
  type Unit,
} from "../schema";
import { othersIn } from "../truth";
import { digest } from "./ledger";
import { areaOf, normalize } from "./units";
import { UNKNOWN } from "./who";
import { localDate, zoneAt } from "./zones";

// The pure parts of stage 2 (memory-pipeline §3.3, §3.4): what the extractor may return, the quote check, entity
// resolution cheapest first, and the observation records. No network or clock.

/** One line of a unit's source text: a message, or one transcript turn. */
export interface Line {
  at: string;
  /** The handle or name the speaker was resolved from (none for the owner): stored as `speakerFrom`. */
  from?: string;
  /** Exact location: the message id, or lifelog's `jobId:turnIndex@capturedAt`. */
  ref: string;
  /** person:<slug>, or unknown:<label>. */
  speaker: string;
  /** A readable name for an unknown speaker: the title of a 1:1 chat (its other member). */
  speakerName?: string;
  text: string;
}

export interface Source {
  lines: Line[];
  unit: Unit;
}

const WHO = /^(person|unknown):/;
/** A speaker as a reader sees it: the readable name when there is one, else the id without its `person:` prefix. */
export const who = (x: { speaker: string; speakerName?: string }) =>
  x.speakerName ?? x.speaker.replace(WHO, "");

const MARKS = /\p{M}/gu;
const SPACE = /\s/u;
const MIN_QUOTE = 8;
const SPOKEN_MAX = 0.6;
/** Below this the model was unsure of a claim (SPOKEN_MAX caps a recorded claim about someone else under it): reads say so. */
export const SURE_AT = 0.7;
const FOLD: Record<string, string> = {
  "«": '"',
  "»": '"',
  Æ: "ae",
  æ: "ae",
  Œ: "oe",
  œ: "oe",
  "–": "-",
  "—": "-",
  "‘": "'",
  "’": "'",
  "‚": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "…": "...",
  "′": "'",
};

/**
 * `s` folded for comparing quotes (no accents, lower case, straight quotes and dashes, one space for any run of
 * white space) and, for each folded code unit, where it came from in `s`.
 */
export function folded(s: string) {
  let out = "";
  const from: number[] = [];
  let i = 0;
  for (const c of s) {
    const f = SPACE.test(c)
      ? " "
      : (FOLD[c] ?? c.normalize("NFKD").replace(MARKS, "").toLowerCase());
    if (!(f === " " && (out === "" || out.endsWith(" ")))) {
      out += f;
      from.push(...new Array<number>(f.length).fill(i));
    }
    i += c.length;
  }
  return { from, out };
}

function find(text: string, quote: string) {
  const q = folded(quote).out.trim();
  const f = folded(text);
  const at = f.out.indexOf(q);
  if (q.length < MIN_QUOTE || at < 0) {
    return null;
  }
  const start = f.from[at] ?? 0;
  const last = f.from[at + q.length - 1] ?? start;
  const end = last + ((text.codePointAt(last) ?? 0) > 0xff_ff ? 2 : 1);
  return { start, verbatim: text.slice(start, end) };
}

/**
 * The quote check: where `quote` sits in the unit's lines, compared without accents, case, quote style or spacing;
 * the hinted line first, then the whole text (a quote may run across lines). Returns the source's own words.
 */
export function locate(quote: string, lines: string[], hint?: number) {
  const hinted = hint === undefined ? undefined : lines[hint];
  const inLine = hinted === undefined ? null : find(hinted, quote);
  if (inLine && hint !== undefined) {
    return { line: hint, verbatim: inLine.verbatim };
  }
  const joined = lines.join("\n");
  const hit = find(joined, quote);
  if (!hit) {
    return null;
  }
  // The line holding the quote's start (a line may itself contain newlines, so counting them in `joined` is not enough).
  let offset = 0;
  const line = lines.findIndex((l) => {
    offset += l.length + 1;
    return hit.start < offset;
  });
  return { line: Math.max(line, 0), verbatim: hit.verbatim };
}

const day = z.iso.date().nullable().default(null);
const ModelObservation = z.object({
  about: z.string().nullish(),
  area: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
  entities: z.array(z.string()).max(12).default([]),
  line: z.int().min(0).optional(),
  modality: Modality.nullish().catch(undefined),
  quote: z.string().min(1).max(600),
  replaces: z.array(z.string()).nullish(),
  salience: z.int().min(1).max(3),
  text: z.string().min(1).max(500),
  type: MemoryType.exclude(["nothing"]),
  unit: z.string(),
  validFrom: day,
  validTo: day,
  when: day,
});

const observationId = (
  unit: string,
  type: string,
  quote: string,
  text: string
) =>
  `obs_${digest("sha1", [unit, type, normalize(quote), normalize(text)].join("|"), 12)}`;

export interface Reject {
  quote?: string;
  reason:
    | "invalid"
    | "unknown-unit"
    | "quote-not-found"
    | "duplicate"
    | "entity-not-candidate";
  text?: string;
  unit?: string;
  value?: string;
}

/** One entity the model gave: a candidate, an unknown name code can resolve or must keep, or something invented. */
export function linkOf(
  e: string,
  candidates: Set<string>,
  resolve: (surface: string) => string | null
): { ref: string } | { surface: string } | { invented: true } {
  if (candidates.has(e)) {
    return { ref: e };
  }
  const surface = e.startsWith(UNKNOWN) ? e.slice(UNKNOWN.length).trim() : "";
  if (!surface) {
    return { invented: true };
  }
  const ref = resolve(surface);
  return ref ? { ref } : { surface };
}

/** One raw observation: valid, from a unit we sent, its quote found in that unit's lines; or why not. */
function cited(
  raw: unknown,
  sources: Map<string, Source>
):
  | Reject
  | {
      found: { line: number; verbatim: string };
      line: Line;
      o: z.infer<typeof ModelObservation>;
      source: Source;
    } {
  const r = ModelObservation.safeParse(raw);
  if (!r.success) {
    return { reason: "invalid", value: JSON.stringify(raw) } satisfies Reject;
  }
  const o = r.data;
  const source = sources.get(o.unit);
  if (!source) {
    return { reason: "unknown-unit", unit: o.unit } satisfies Reject;
  }
  const found = locate(
    o.quote,
    source.lines.map((l) => l.text),
    o.line
  );
  const line = found && source.lines[found.line];
  if (!(found && line)) {
    return {
      quote: o.quote,
      reason: "quote-not-found",
      text: o.text,
      unit: o.unit,
    } satisfies Reject;
  }
  return { found, line, o, source };
}

/** The observation record of a cited, linked claim. */
function recordOf(
  { found, line, o, source }: Exclude<ReturnType<typeof cited>, Reject>,
  id: string,
  { about, entities }: { about?: string; entities: Set<string> },
  ctx: {
    areas: Map<string, string>;
    madeBy: MadeBy;
  }
): Observation {
  // A single spoken source about someone else stays a maybe (design §3.3).
  const spoken =
    source.unit.source === "lifelog" && othersIn([...entities]).length > 0;
  return {
    ...(about ? { about } : {}),
    area: areaOf(o.area, ctx.areas),
    at: line.at,
    confidence: spoken ? Math.min(o.confidence, SPOKEN_MAX) : o.confidence,
    date: localDate(line.at),
    entities: [...entities].sort(),
    id,
    madeBy: { ...ctx.madeBy, unitHash: source.unit.hash },
    ...(o.modality ? { modality: o.modality } : {}),
    quote: found.verbatim,
    salience: o.salience,
    schemaVersion: 1,
    source: { channel: source.unit.source, ref: line.ref },
    speaker: line.speaker,
    ...(line.from ? { speakerFrom: line.from } : {}),
    ...(line.speakerName ? { speakerName: line.speakerName } : {}),
    text: o.text,
    type: o.type,
    tz: zoneAt(line.at),
    unit: o.unit,
    validFrom: o.validFrom,
    validTo: o.validTo,
    when: o.when,
  };
}

/** An observation's `entities` and `about` as refs: candidates, or names code resolves; the rest kept or rejected. */
function links(
  o: z.infer<typeof ModelObservation>,
  id: string,
  candidates: Set<string>,
  resolve: (surface: string) => string | null
) {
  const entities = new Set<string>();
  const rejects: Reject[] = [];
  const unresolved: { observation: string; surface: string; unit: string }[] =
    [];
  for (const e of o.entities) {
    const link = linkOf(e, candidates, resolve);
    if ("ref" in link) {
      entities.add(link.ref);
    } else if ("surface" in link) {
      unresolved.push({ observation: id, surface: link.surface, unit: o.unit });
    } else {
      rejects.push({ reason: "entity-not-candidate", unit: o.unit, value: e });
    }
  }
  const said = o.about ? linkOf(o.about, candidates, resolve) : null;
  const about = said && "ref" in said ? said.ref : undefined;
  if (about) {
    entities.add(about);
  }
  return { about, entities, rejects, unresolved };
}

/**
 * The extractor's reply for one batch, checked: valid shape, a unit we sent, a quote found in that unit's text,
 * entities and `about` from the candidate list (an `unknown:<name>` is resolved by code when it can, else kept as
 * unresolved), an area from the area list or none. A `replaces` stands only for a `prior`
 * observation said before the new one's line. Everything rejected is returned with its reason, never trusted.
 */
export function parseObservations(
  reply: unknown,
  ctx: {
    areas: Map<string, string>;
    candidates: Set<string>;
    madeBy: MadeBy;
    prior?: Map<string, Observation>;
    /** Who a name or handle is (`readPeople`'s, as `parseDay` takes it). */
    resolve: (surface: string) => string | null;
    sources: Map<string, Source>;
  }
) {
  const list = z
    .object({ observations: z.array(z.unknown()) })
    .parse(reply).observations;
  const observations: Observation[] = [];
  const rejects: Reject[] = [];
  const unresolved: { observation: string; surface: string; unit: string }[] =
    [];
  const replaced: { by: Observation; old: Observation }[] = [];
  for (const raw of list) {
    const c = cited(raw, ctx.sources);
    if ("reason" in c) {
      rejects.push(c);
      continue;
    }
    const { found, o } = c;
    const id = observationId(o.unit, o.type, found.verbatim, o.text);
    if (observations.some((x) => x.id === id)) {
      rejects.push({ reason: "duplicate", unit: o.unit });
      continue;
    }
    const { about, entities, ...linked } = links(
      o,
      id,
      ctx.candidates,
      ctx.resolve
    );
    rejects.push(...linked.rejects);
    unresolved.push(...linked.unresolved);
    const made = recordOf(c, id, { about, entities }, ctx);
    observations.push(made);
    for (const old of (o.replaces ?? []).flatMap(
      (x) => ctx.prior?.get(x) ?? []
    )) {
      if (old.at < made.at) {
        replaced.push({ by: made, old });
      }
    }
  }
  return { observations, rejects, replaced, unresolved };
}
