import type { SourceName } from "../core/names";
import type { Unresolved } from "../records/observation";
import { parseTurnRef } from "../sources/lifelog";
import { readTurnClip } from "../sources/lifelog-voices";
import type { Check, Said } from "./life-checks";
import { readUnitsFor } from "./memory-files";
import type { SourceLine } from "./quote-check";
import { OWNER } from "./read-truth";
import { kindOf } from "./sources";
import { isFrozen, nameKey } from "./units";
import type { People } from "./who";
import { readEach, spokenLines, unitLines } from "./words";

// What a name check shows of its sentence: the line of the unit that holds the name, verbatim, with who said it, to
// whom, when; the lines before and after; for a spoken one, its clip and lifelog's word timings. One unit read per
// card, read when the inbox is, kept while its unit's hash is the same, so a new read of the inbox reads only the names
// that are new or whose unit changed. A unit that cannot be read leaves the card with the observation's quote.

/** How many lines of the unit show before and after the sentence. */
const AROUND = 3;

/** Whether `text` holds one of `names` as a whole word or words (`nameKey`, so accents and case never matter). */
export const holdsName = (text: string, names: string[]) =>
  names.some((n) => ` ${nameKey(text)} `.includes(` ${nameKey(n)} `));

/** What a name check carries of its sentence. */
export interface NameContext {
  after: Said[];
  before: Said[];
  clips: Check["clips"];
  said: Said;
}

/** A name check to read: its key, the names as written, and the kept line it shows (the newest holding the name). */
export interface WantedName {
  key: string;
  line: { id: string; unit: string };
  names: string[];
}

/** The last read, by observation id: kept while the unit's hash (the unit as it was) is the same. */
let kept = new Map<string, { context: NameContext; hash: string }>();

/** The owner is "You"; anyone else is their name as the people know it. */
export const byOf = (
  people: Pick<People, "nameOf">,
  speaker: string,
  speakerName?: string
) => (speaker === OWNER ? "You" : (speakerName ?? people.nameOf(speaker)));

const saidOf = (
  l: SourceLine,
  channel: SourceName,
  to: string | null,
  people: Pick<People, "nameOf">
): Said => ({
  at: l.at,
  by: byOf(people, l.speaker, l.speakerName),
  channel,
  text: l.text,
  to,
});

/** The contexts of `wanted`, by name key; a name whose unit cannot be read has none. */
export async function readNameContexts(
  wanted: WantedName[],
  people: People
): Promise<Map<string, NameContext>> {
  const units = new Map(
    readUnitsFor(wanted.map((w) => w.line.unit)).map((u) => [u.id, u])
  );
  const next = new Map<string, { context: NameContext; hash: string }>();
  const read = await readEach(
    wanted.map((w) => w.key),
    async (key) => {
      const w = wanted.find((x) => x.key === key) as WantedName;
      const unit = units.get(w.line.unit);
      const cached = kept.get(w.line.id);
      if (!unit || isFrozen(unit)) {
        return null;
      }
      if (cached?.hash === unit.hash) {
        next.set(w.line.id, cached);
        return cached.context;
      }
      try {
        const lines =
          kindOf(unit.source) === "voice"
            ? ((await spokenLines([unit], people.resolve, people.truth)).get(
                unit.id
              ) ?? [])
            : ((await unitLines(unit, people))?.lines ?? []);
        const at = lines.findIndex((l) => holdsName(l.text, w.names));
        const found = lines[at];
        if (!found) {
          return null;
        }
        const to = unit.title === unit.key ? null : unit.title;
        const turn = parseTurnRef(found.ref);
        const clip =
          turn &&
          (await readTurnClip(turn.jobId, turn.turnIndex).catch(() => null));
        const show = (l: SourceLine) => saidOf(l, unit.source, to, people);
        const context = {
          after: lines.slice(at + 1, at + 1 + AROUND).map(show),
          before: lines.slice(Math.max(0, at - AROUND), at).map(show),
          clips: clip ? [clip] : [],
          said: show(found),
        };
        next.set(w.line.id, { context, hash: unit.hash });
        return context;
      } catch {
        // lifelog or an archive not answering: the card keeps the observation's quote, and the next read tries again.
        return null;
      }
    }
  );
  kept = next;
  return new Map(
    [...read].flatMap(([key, context]) => (context ? [[key, context]] : []))
  );
}

/** A kept line as it was said: its quote, who, in which chat or thread (`titles`), on which channel, on its day. */
export const saidOfLine = (
  l: SaidLine,
  people: Pick<People, "nameOf">,
  titles: ReadonlyMap<string, string>
): Said => ({
  at: l.date,
  by: byOf(people, l.speaker),
  channel: l.source.channel,
  text: l.quote,
  to: titles.get(l.unit) ?? null,
});

/** Words with no line of ours behind them (a step that is an episode's or a to-do item's): their day, nobody known. */
export const saidOfQuote = (text: string, at: string | null): Said => ({
  at,
  by: null,
  channel: null,
  text,
  to: null,
});

/**
 * The names Life cannot place, one group per name (`nameKey`): the names as written, the kept lines that hold them and the
 * one the card shows: the newest whose quote holds the name, else the newest.
 */
export function nameGroupsOf<L extends NameLine>(c: {
  kept: ReadonlySet<string>;
  lines: readonly L[];
  people: Pick<People, "resolve">;
  unresolved: readonly Pick<Unresolved, "nameAsWritten" | "observation">[];
}) {
  const open = c.unresolved.filter(
    (r) => r.observation && !c.people.resolve(r.nameAsWritten)
  );
  const ids = new Set(open.map((r) => r.observation));
  const byId = new Map(
    c.lines.filter((l) => ids.has(l.id)).map((l) => [l.id, l])
  );
  return [
    ...Map.groupBy(open, (r) => nameKey(r.nameAsWritten) || r.nameAsWritten),
  ].map(([key, rows]) => {
    const names = [...new Set(rows.map((r) => r.nameAsWritten))];
    const lines = [...new Set(rows.map((r) => r.observation))].flatMap((id) => {
      const l = id ? byId.get(id) : undefined;
      return l && c.kept.has(l.id) ? [l] : [];
    });
    const holding = lines.filter((l) => holdsName(l.quote, names));
    const shown = holding.length > 0 ? holding : lines;
    return {
      key,
      last:
        shown.length > 0
          ? shown.reduce((m, l) => (l.date > m.date ? l : m))
          : undefined,
      lines,
      names,
    };
  });
}

/** The line a card's sentence comes from, as the checks hold it. */
type SaidLine = Pick<SourceLine, "speaker"> & {
  date: string;
  quote: string;
  source: { channel: SourceName };
  unit: string;
};
type NameLine = SaidLine & { id: string };

/**
 * What the cards that show a sentence need read: each name's context, and the titles (chat or thread) of the units
 * their lines come from: a name's, the inferred people's evidence, and the first step of each matter and both ends of each ending.
 */
export async function readSentences(c: {
  kept: ReadonlySet<string>;
  lines: readonly NameLine[];
  matters: readonly { steps: readonly { ref: string }[] }[];
  people: People;
  unresolved: readonly Pick<Unresolved, "nameAsWritten" | "observation">[];
  records: { linkEndings: ReadonlyMap<string, { later: string }> };
}) {
  const names = nameGroupsOf(c);
  const nameContexts = await readNameContexts(
    names.flatMap(({ key, last, names: as }) =>
      last ? [{ key, line: last, names: as }] : []
    ),
    c.people
  );
  const stepIds = new Set([
    ...[...c.records.linkEndings].flatMap(([ref, e]) => [ref, e.later]),
    ...c.matters.flatMap((m) => m.steps.slice(0, 1).map((s) => s.ref)),
  ]);
  const said = c.lines.filter((o) => stepIds.has(o.id)).map((o) => o.unit);
  const units = readUnitsFor([
    ...c.people.inferred.flatMap((p) => p.evidence.map((e) => e.unit)),
    ...said,
  ]);
  return {
    nameContexts,
    titles: new Map(
      units.flatMap((u) => (u.title === u.key ? [] : [[u.id, u.title]]))
    ),
    units,
  };
}
