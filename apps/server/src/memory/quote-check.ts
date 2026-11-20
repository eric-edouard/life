import { z } from "zod";
import { digest } from "../core/hash";
import { type FoundQuote, type MadeBy, QUOTE_CHARS } from "../records/fields";
import { Modality, type Observation } from "../records/observation";
import type { Unit } from "../records/unit";
import { MemoryType } from "../records/unit";
import { othersIn } from "./read-truth";
import { kindOf } from "./sources";
import { areaOf } from "./tags";
import { clip, normalize, UNKNOWN } from "./units";
import { localDate, zoneAt } from "./zones";

// The pure parts of extraction (docs/architecture.md, "The pipeline"): what the extractor may return, the quote check, entity
// resolution cheapest first, and the observation records. No network or clock.

/** One line of a unit's source text: a message, or one transcript turn. */
export interface SourceLine {
  at: string;
  /** The handle or name the speaker was resolved from (none for the owner): stored as `speakerFrom`. */
  from?: string;
  /** Exact location: the message id, or lifelog's `jobId:turnIndex@capturedAt`. */
  ref: string;
  /** person:<slug>, unknown:<label>, or agent:<name> (`speakerOf`). */
  speaker: string;
  /** A readable name for an unknown speaker: the title of a 1:1 chat (its other member). */
  speakerName?: string;
  text: string;
  /** A recorded turn's voice: its label in its recording (`voiceKey`), kept so a read can tell the voices apart. */
  voice?: string;
}

export interface Source {
  /**
   * A continued unit's first new line: a quote is looked for from there first, then from the line before (a quote may
   * run across two lines), and one that ends before it is an earlier reading's, rejected (`already-read`).
   */
  from?: number;
  lines: SourceLine[];
  unit: Unit;
}

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

/** Where `quote` sits in `text`, folded (`folded`): the first occurrence ending past `endAfter`, scanned in one fold. */
function find(text: string, quote: string, endAfter = 0) {
  const q = folded(quote).out.trim();
  if (q.length < MIN_QUOTE) {
    return null;
  }
  const f = folded(text);
  for (let at = f.out.indexOf(q); at >= 0; at = f.out.indexOf(q, at + 1)) {
    const start = f.from[at] ?? 0;
    const last = f.from[at + q.length - 1] ?? start;
    const end = last + ((text.codePointAt(last) ?? 0) > 0xff_ff ? 2 : 1);
    if (end > endAfter) {
      return { start, verbatim: text.slice(start, end) };
    }
  }
  return null;
}

/**
 * The quote check: where `quote` sits in the unit's lines, compared without accents, case, quote style or spacing;
 * the hinted line first (one before a continued unit's first new line `from` is looked past), then the first occurrence
 * reaching line `from` (a quote may run across lines), then the whole text. Returns the source's own words and the
 * lines holding their start (`line`) and their end (`lastLine`).
 */
export function locate(
  quote: string,
  lines: string[],
  hint?: number,
  from = 0
) {
  const hinted = hint === undefined ? undefined : lines[hint];
  const inLine = hinted === undefined ? null : find(hinted, quote);
  // A hint before a continued unit's new lines is looked past: the same words may run into them.
  if (inLine && hint !== undefined && hint >= from) {
    return { lastLine: hint, line: hint, verbatim: inLine.verbatim };
  }
  const joined = lines.join("\n");
  // A continued unit's quote: the first one reaching its new lines (running into them or in them), else anywhere.
  const newFrom = lines.slice(0, from).join("\n").length + 1;
  const hit =
    (from > 0 ? find(joined, quote, newFrom) : null) ?? find(joined, quote);
  if (!hit) {
    return null;
  }
  // The line holding a character (a line may itself contain newlines, so counting them in `joined` is not enough).
  const lineAt = (at: number) => {
    let offset = 0;
    return Math.max(
      lines.findIndex((l) => {
        offset += l.length + 1;
        return at < offset;
      }),
      0
    );
  };
  return {
    lastLine: lineAt(hit.start + hit.verbatim.length - 1),
    line: lineAt(hit.start),
    verbatim: hit.verbatim,
  };
}

const day = z.iso.date().nullable().default(null);
const ModelObservation = z.object({
  about: z.string().nullish(),
  area: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
  importance: z.int().min(1).max(3),
  line: z.int().min(0).optional(),
  modality: Modality.nullish().catch(undefined),
  quote: z.string().min(1).max(600),
  replaces: z.array(z.string()).nullish(),
  subjects: z.array(z.string()).max(12).default([]),
  text: z.string().min(1).max(500),
  type: MemoryType.exclude(["nothing"]),
  unit: z.string(),
  validFrom: day,
  validTo: day,
  when: day,
});

export const observationId = (
  unit: string,
  type: string,
  quote: string,
  text: string
) =>
  `obs_${digest("sha1", [unit, type, normalize(quote), normalize(text)].join("|"), 12)}`;

export interface Reject {
  quote?: string;
  reason:
    | "already-read"
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
export function subjectOf(
  e: string,
  candidates: Set<string>,
  resolve: (nameOrHandle: string) => string | null
): { ref: string } | { nameAsWritten: string } | { invented: true } {
  if (candidates.has(e)) {
    return { ref: e };
  }
  const nameAsWritten = e.startsWith(UNKNOWN)
    ? e.slice(UNKNOWN.length).trim()
    : "";
  if (!nameAsWritten) {
    return { invented: true };
  }
  const ref = resolve(nameAsWritten);
  return ref ? { ref } : { nameAsWritten };
}

const textsOf = (s: Source) => s.lines.map((l) => l.text);

/** The one unit of the call whose lines hold `quote`; none when no unit or several do. */
function unitHoldingOf(quote: string, sources: Map<string, Source>) {
  const holding = [...sources.values()].filter((s) =>
    locate(quote, textsOf(s))
  );
  return holding.length === 1 ? holding[0] : undefined;
}

/**
 * One raw observation: valid, its quote found in the unit it cites, or else in the one unit of the call that holds it
 * (the model mixes up unit ids: an episode's id, a typo, a neighbour's; audit 2026-11-16); or why not.
 */
function cited(
  raw: unknown,
  sources: Map<string, Source>
):
  | Reject
  | {
      found: { lastLine: number; line: number; verbatim: string };
      line: SourceLine;
      o: z.infer<typeof ModelObservation>;
      source: Source;
    } {
  const r = ModelObservation.safeParse(raw);
  if (!r.success) {
    return { reason: "invalid", value: JSON.stringify(raw) } satisfies Reject;
  }
  const o = r.data;
  const named = sources.get(o.unit);
  const inNamed = named && locate(o.quote, textsOf(named), o.line, named.from);
  const source = inNamed ? named : unitHoldingOf(o.quote, sources);
  // The line hint belongs to the cited unit only.
  const found =
    inNamed ||
    (source && locate(o.quote, textsOf(source), undefined, source.from));
  const line = found && source?.lines[found.line];
  if (!(source && found && line)) {
    return named
      ? {
          quote: o.quote,
          reason: "quote-not-found",
          text: o.text,
          unit: o.unit,
        }
      : { reason: "unknown-unit", unit: o.unit };
  }
  // A quote ending before a continued unit's new lines is a fact its earlier reading kept already.
  if (source.from && found.lastLine < source.from) {
    return {
      quote: o.quote,
      reason: "already-read",
      text: o.text,
      unit: source.unit.id,
    };
  }
  return { found, line, o: { ...o, unit: source.unit.id }, source };
}

/** The observation record of a cited, linked claim. */
function recordOf(
  { found, line, o, source }: Exclude<ReturnType<typeof cited>, Reject>,
  id: string,
  { about, subjects }: { about?: string; subjects: Set<string> },
  ctx: {
    areas: Map<string, string>;
    madeBy: MadeBy;
  }
): Observation {
  // A single spoken source about someone else stays a maybe (design §3.3).
  const spoken =
    kindOf(source.unit.source) === "voice" &&
    othersIn([...subjects]).length > 0;
  return {
    ...(about ? { about } : {}),
    area: areaOf(o.area, ctx.areas),
    at: line.at,
    confidence: spoken ? Math.min(o.confidence, SPOKEN_MAX) : o.confidence,
    date: localDate(line.at),
    id,
    madeBy: { ...ctx.madeBy, unitHash: source.unit.hash },
    subjects: [...subjects].sort(),
    ...(o.modality ? { modality: o.modality } : {}),
    importance: o.importance,
    quote: found.verbatim,
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

/** An observation's `subjects` and `about` as refs: candidates, or names code resolves; the rest kept or rejected. */
function subjectsOf(
  o: z.infer<typeof ModelObservation>,
  id: string,
  candidates: Set<string>,
  resolve: (nameOrHandle: string) => string | null
) {
  const subjects = new Set<string>();
  const rejects: Reject[] = [];
  const unresolved: {
    observation: string;
    nameAsWritten: string;
    unit: string;
  }[] = [];
  for (const e of o.subjects) {
    const link = subjectOf(e, candidates, resolve);
    if ("ref" in link) {
      subjects.add(link.ref);
    } else if ("nameAsWritten" in link) {
      unresolved.push({
        nameAsWritten: link.nameAsWritten,
        observation: id,
        unit: o.unit,
      });
    } else {
      rejects.push({ reason: "entity-not-candidate", unit: o.unit, value: e });
    }
  }
  const said = o.about ? subjectOf(o.about, candidates, resolve) : null;
  const about = said && "ref" in said ? said.ref : undefined;
  if (about) {
    subjects.add(about);
  }
  return { about, rejects, subjects, unresolved };
}

/**
 * The extractor's reply for one batch, checked: valid shape, a unit we sent, a quote found in that unit's text,
 * subjects and `about` from the candidate list (an `unknown:<name>` is resolved by code when it can, else kept as
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
    resolve: (nameOrHandle: string) => string | null;
    sources: Map<string, Source>;
  }
) {
  const list = z
    .object({ observations: z.array(z.unknown()) })
    .parse(reply).observations;
  const observations: Observation[] = [];
  const rejects: Reject[] = [];
  const unresolved: {
    observation: string;
    nameAsWritten: string;
    unit: string;
  }[] = [];
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
    const { about, subjects, ...linked } = subjectsOf(
      o,
      id,
      ctx.candidates,
      ctx.resolve
    );
    rejects.push(...linked.rejects);
    unresolved.push(...linked.unresolved);
    const made = recordOf(c, id, { about, subjects }, ctx);
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

/** The quotes a model gave, each kept only as words found in a message it was shown (`locate`), with that message. */
export function foundQuotes<M extends { text: string }>(
  quotes: string[],
  pool: M[]
) {
  const texts = pool.map((m) => m.text);
  return quotes.flatMap((q) => {
    const found = locate(q, texts);
    const message = found ? pool[found.line] : undefined;
    return found && message ? [{ message, text: found.verbatim }] : [];
  });
}

/** At most four of the quotes a model gave, found in `pool` (`foundQuotes`), each with its message's time and clipped to `QUOTE_CHARS`. */
export const foundQuotesAt = <M extends { at: string; text: string }>(
  quotes: string[],
  pool: M[]
): FoundQuote[] =>
  foundQuotes(quotes, pool)
    .slice(0, 4)
    .map((q) => ({ at: q.message.at, text: clip(q.text, QUOTE_CHARS) }));
