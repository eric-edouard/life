import type { SourceName } from "../core/names";
import type { Unresolved } from "../records/observation";
import type { Unit } from "../records/unit";
import { parseTurnRef } from "../sources/lifelog";
import { readTurnClip } from "../sources/lifelog-voices";
import { plain } from "./doubts";
import type { Check, Said } from "./life-checks";
import { offerEndOf } from "./matter-read";
import { readUnitsFor } from "./memory-files";
import { locate, type SourceLine } from "./quote-check";
import { OWNER } from "./read-truth";
import { kindOf } from "./sources";
import { holdsName, isFrozen, nameKey } from "./units";
import type { People } from "./who";
import { readEach, spokenLines, unitLines } from "./words";

// What a name check shows of its sentence: the line of the unit that holds the name, verbatim, with who said it, to
// whom, when; for a spoken one, its clip and lifelog's word timings. One unit read per
// card, read when the inbox is, kept while its unit's hash is the same, so a new read of the inbox reads only the names
// that are new or whose unit changed. A unit that cannot be read leaves the card with the observation's quote.

/** What a name check carries of its sentence. */
export interface NameContext {
  clips: Check["clips"];
  said: Said;
}

/** A name check to read: its key, the names as written, and the kept line it shows (the newest holding the name). */
export interface WantedName {
  key: string;
  line: { id: string; quote: string; unit: string };
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

/** The contexts of `wanted`, by name key, from their units as read (`held`); a name whose unit was not read has none. */
export async function readNameContexts(
  wanted: WantedName[],
  people: People,
  held: readonly Unit[]
): Promise<Map<string, NameContext>> {
  const units = new Map(held.map((u) => [u.id, u]));
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
        // The observation's own sentence first; a quote too short or reworded falls back to the first line holding the name.
        const at =
          locate(
            w.line.quote,
            lines.map((l) => l.text)
          )?.line ?? lines.findIndex((l) => holdsName(l.text, w.names));
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

/** Where and when a line was said, in words: "whatsapp, 7 Sep". */
export const whereOf = (l: { date: string; source: { channel: string } }) =>
  `${l.source.channel}, ${plain(l.date)}`;

/** Words with no line of ours behind them (a step that is an episode's or a to-do item's): their day, nobody known. */
export const saidOfQuote = (text: string, at: string | null): Said => ({
  at,
  by: null,
  channel: null,
  text,
  to: null,
});

/** The days a name Life cannot place must be seen on, without an exchange, to be asked (his word of 20 Nov 2026, life#724). */
export const NAME_ASKED_AFTER_DAYS = 3;

/** A description, not a name: every way it was written starts with a lowercase letter ("sister", "la femme des bois"); a sender's own name (a lowercase handle) never is one. */
const isDescription = (names: readonly string[]) =>
  names.every((n) => LOWERCASE_FIRST.test(n.trim()));
const LOWERCASE_FIRST = /^\p{Ll}/u;

export type NameRow = Pick<
  Unresolved,
  "date" | "nameAsWritten" | "observation" | "unit" | "via"
>;

/**
 * The names Life cannot place that are asked, one group per name (`nameKey`): the names as written, the kept lines that
 * hold them and the one the card shows: the newest whose quote holds the name, else the newest. A name is asked only
 * while the person matters (his word of 20 Nov 2026, life#724): it was seen on `NAME_ASKED_AFTER_DAYS` days or more (any
 * row), or he exchanged with them (they spoke in a unit holding his words too: `hisUnitsOf`, asked once for the names
 * still in doubt); never a description unless its sender wrote it (this rule decides: the extraction prompt only keeps new rows clean), nor a
 * name he said not to name (`not-worth-naming`). A card needs a row with an observation; a name not asked stays as
 * written, and is asked again when it returns.
 */
export function nameGroupsOf<L extends NameLine>(c: {
  /** Which of `units` hold his own words (he wrote or spoke there). */
  hisUnitsOf: (units: readonly string[]) => ReadonlySet<string>;
  kept: ReadonlySet<string>;
  lines: readonly L[];
  /** Who a name is, and his corrections: a name he said not to name (`not-worth-naming`) is never asked. */
  people: Pick<People, "corrections" | "resolve">;
  unresolved: readonly NameRow[];
}) {
  const unnamed = new Set(
    c.people.corrections.flatMap((x) =>
      x.kind === "not-worth-naming" ? [nameKey(x.nameOrHandle)] : []
    )
  );
  const keyOf = (r: NameRow) => nameKey(r.nameAsWritten) || r.nameAsWritten;
  const placed = c.unresolved.filter((r) => !c.people.resolve(r.nameAsWritten));
  const rowsBy = Map.groupBy(placed, keyOf);
  const open = [
    ...Map.groupBy(
      placed.filter((r) => r.observation),
      keyOf
    ),
  ].flatMap(([key, rows]) => {
    const names = [...new Set(rows.map((r) => r.nameAsWritten))];
    const all = rowsBy.get(key) ?? rows;
    const isMentionOnly = all.every((r) => r.via !== "speaker");
    return unnamed.has(key) || (isMentionOnly && isDescription(names))
      ? []
      : [
          {
            all,
            isSeenOften:
              new Set(all.map((r) => r.date)).size >= NAME_ASKED_AFTER_DAYS,
            key,
            names,
            rows,
          },
        ];
  });
  const spokeIn = (g: (typeof open)[number]) =>
    g.all.flatMap((r) => (r.via === "speaker" ? [r.unit] : []));
  const his = c.hisUnitsOf([
    ...new Set(open.filter((g) => !g.isSeenOften).flatMap(spokeIn)),
  ]);
  const ids = new Set(open.flatMap((g) => g.rows.map((r) => r.observation)));
  const byId = new Map(
    c.lines.filter((l) => ids.has(l.id)).map((l) => [l.id, l])
  );
  return open
    .filter((g) => g.isSeenOften || spokeIn(g).some((u) => his.has(u)))
    .map(({ key, names, rows }) => {
      const lines = [...new Set(rows.map((r) => r.observation))].flatMap(
        (id) => {
          const l = id ? byId.get(id) : undefined;
          return l && c.kept.has(l.id) ? [l] : [];
        }
      );
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
 * What the cards that show a sentence need read: each name's context, and the titles (chat or thread) of the units the
 * lines come from: a name's, the inferred people's evidence, and `steps`, the open endings' and new matters' steps;
 * where each was said is read from the same units, so a card's quote links only a unit read here.
 */
export async function readSentences(c: {
  lines: readonly NameLine[];
  names: ReturnType<typeof nameGroupsOf>;
  people: People;
  steps: ReadonlySet<string>;
}) {
  const wanted = c.names.flatMap(({ key, last, names }) =>
    last ? [{ key, line: last, names }] : []
  );
  const said = c.lines.filter((o) => c.steps.has(o.id)).map((o) => o.unit);
  const units = readUnitsFor([
    ...c.people.inferred.flatMap((p) => p.evidence.map((e) => e.unit)),
    ...wanted.map((w) => w.line.unit),
    ...said,
  ]);
  const nameContexts = await readNameContexts(wanted, c.people, units);
  return {
    nameContexts,
    titles: new Map(
      units.flatMap((u) => (u.title === u.key ? [] : [[u.id, u.title]]))
    ),
    /** Where each unit read was said: what a card's quote links (`CheckInputs.where`). */
    where: new Map(units.map((u) => [u.id, `${u.source}, ${plain(u.date)}`])),
  };
}

/**
 * Whether an open step with an ending found is an ending check: no old doubt line holds its ref, he has not answered,
 * and the link's later record (when it is a line) is not his own words: then it stays probably done, no card.
 */
export const isEndingOpen = (
  ref: string,
  c: { answered: ReadonlySet<string>; doubted: ReadonlySet<string> },
  later?: { speaker: string }
) => !(c.doubted.has(ref) || c.answered.has(ref) || later?.speaker === OWNER);

/** The steps a card shows the sentence of: the open endings' (a step and what ended it) and the new matters' first steps; a closed ending's or an old matter's are never read. */
export const shownStepsOf = (c: {
  answered: ReadonlySet<string>;
  doubted: ReadonlySet<string>;
  endings: ReadonlyMap<string, { later: string }>;
  lines: readonly { id: string; speaker: string }[];
  today: string;
  matters: readonly { steps: readonly { day: string; ref: string }[] }[];
}) => {
  const lineById = new Map(c.lines.map((l) => [l.id, l]));
  return new Set([
    ...[...c.endings].flatMap(([ref, e]) =>
      isEndingOpen(ref, c, lineById.get(e.later)) ? [ref, e.later] : []
    ),
    ...c.matters.flatMap((m) => {
      const end = offerEndOf(m);
      return end && c.today <= end && m.steps[0] ? [m.steps[0].ref] : [];
    }),
  ]);
};
