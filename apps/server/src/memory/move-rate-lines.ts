import { CHANCE, isTooFew, type Thing } from "./move-rates";
import type { StoredMoveRate } from "./move-rates-file";

// The stored move rates (`move-rates-file.ts`) of one person as plain sentences for the top of the person read, and
// the rules of what is worth showing of them (shared with the table block). Pure: rows in, lines out, no model.

/** A line low everywhere (under this share, all time) is left out of the table unless it is at an extreme. */
export const LOW_SHARE = 0.05;
/** A place among people is said only with this many others who have a share. */
export const PLACE_MIN_PEOPLE = 6;
/** At an extreme: among this many from the top or the bottom. */
export const EXTREME = 3;
/** A gap between he and they, and a change between the last 12 months and before, worth a sentence (points). */
const GAP_POINTS = 15;
const CHANGE_POINTS = 10;
/** The most sentences of what else stands out. */
const MORE = 6;
/** Fewest exchanges where the other raised a fault, and where something was decided, for a sentence of answers. */
const FAULT_MIN = 5;
const DECISION_MIN = 15;
/** A difference between the sides' settling, in points, that is said. */
const SETTLING_POINTS = 10;

/** Whether a row stands at an extreme among the other people (it has a place only when enough have a share). */
export const isExtreme = (r: StoredMoveRate) =>
  r.among >= PLACE_MIN_PEOPLE && (r.above < EXTREME || r.below < EXTREME);

const thingOf = (r: StoredMoveRate) => r.thing as Thing;
const chanceOf = (r: StoredMoveRate) => CHANCE[thingOf(r)];

/**
 * The channels to show: those active lately (the `tension` row, else the busiest row, has chances in the last 12
 * months); when none is, the busiest one. The others are `left`, with their exchanges and how many were lately.
 */
export function channelsOf(rows: StoredMoveRate[]) {
  const channels = [
    ...Map.groupBy(
      rows.filter((r) => r.source),
      (r) => r.source ?? ""
    ),
  ].map(([source, list]) => {
    const own = list.filter((r) => r.thing === "tension");
    const pool = own.length > 0 ? own : list;
    return {
      all: Math.max(...pool.map((r) => r.all.of)),
      lately: Math.max(...pool.map((r) => r.lately.of)),
      source,
    };
  });
  const active = channels.filter((c) => !isTooFew(c.lately));
  const busiest = channels.toSorted((a, b) => b.all - a.all).slice(0, 1);
  const shown = new Set(
    (active.length > 0 ? active : busiest).map((c) => c.source)
  );
  return { left: channels.filter((c) => !shown.has(c.source)), shown };
}

/** What each thing counted is, as a noun phrase; typed over every thing, so a new code fails types until it has one. */
const LABEL: Record<Thing, string> = {
  affection: "Saying affection",
  against: "Turning against the other's bid",
  apologises: "Apologising",
  asks_about: "Asking about the other",
  asks_for: "Asking for something",
  away: "Letting the other's bid pass",
  believes: "Saying what they believe",
  blames: "Placing blame",
  conflict: "A conflict",
  contempt: "Showing contempt",
  counters: "Countering with a fault of the other",
  decides: "Settling it, when something is decided",
  defers: "Leaving it to the other, when something is decided",
  denies: "Denying",
  directs: "Telling the other what to do, when something is decided",
  discloses: "Disclosing something personal",
  distress: "Appealing to their own distress",
  engages: "Engaging with a fault",
  excuses: "Making an excuse",
  explores: "Exploring an idea",
  fault: "Raising a fault",
  feels: "Saying how they feel",
  gives: "Giving something",
  good_news: "Sharing good news",
  intends: "Saying what they intend",
  invites: "Inviting",
  mention: "Talking about someone else",
  moves_on: "Moving on",
  offers: "Offering something",
  presses: "Pressing",
  proposes: "Proposing, when something is decided",
  reassurance_asked: "Asking for reassurance",
  refuses: "Refusing",
  returns: "Giving something back",
  shares: "Sharing something of their day",
  support_asked: "Asking for support",
  support_given: "Giving support",
  tension: "Some tension",
  thanks: "Thanking",
  toward: "Taking up the other's bid",
  unanswered: "Leaving the other's bid unanswered",
  wants: "Saying what they want",
  warm: "Reading warm",
  yields: "Yielding",
};

/** How an answer to a fault is told after its subject: "they apologised in 4". */
const ANSWER_VERB = {
  apologises: "apologised",
  counters: "countered with a fault of the other",
  denies: "denied",
  engages: "engaged with it",
  excuses: "made an excuse",
  moves_on: "said to move on",
  yields: "yielded",
};

const pct = ({ n, of }: { n: number; of: number }) =>
  Math.round((100 * n) / of);
const who = (side: "me" | "them") => (side === "me" ? "he" : "they");
const isFlag = (r: StoredMoveRate) => !r.side;
const isShare = (r: StoredMoveRate) => r.says === "share";
const shareOf = (r: StoredMoveRate) => r.all.n / r.all.of;

/** The shares of a thing's rows, they first: "they in 28%, he in 34%" (a flag: "in 16% of their exchanges"). */
function sharesText(group: StoredMoveRate[]) {
  const [first] = group;
  if (!first || isFlag(first)) {
    return `in ${first ? pct(first.all) : 0}% of their exchanges`;
  }
  return group
    .toSorted((a, b) => (b.side ?? "").localeCompare(a.side ?? ""))
    .map((r) => `${who(r.side ?? "me")} in ${pct(r.all)}%`)
    .join(", ");
}

/** Where the most extreme row of a group stands: "more than all but 2 of 27 other people", with its side. */
function placeText(group: StoredMoveRate[]) {
  const [row] = group
    .filter(isExtreme)
    .toSorted(
      (a, b) => Math.min(a.above, a.below) - Math.min(b.above, b.below)
    );
  if (!row) {
    return null;
  }
  const top = row.above <= row.below;
  const more = top ? "more" : "less";
  const count = top ? row.above : row.below;
  const flag = isFlag(row);
  return `${flag ? "" : `${who(row.side ?? "me")} `}${more} than ${flag ? "with " : ""}all but ${count} of ${row.among} other people`;
}

/** The biggest change between the last 12 months and before, in points, among rows with chances in both. */
function changeOf(group: StoredMoveRate[]) {
  return group
    .filter((r) => !(isTooFew(r.lately.of) || isTooFew(r.before.of)))
    .map((r) => ({ points: pct(r.lately) - pct(r.before), row: r }))
    .toSorted((a, b) => Math.abs(b.points) - Math.abs(a.points))[0];
}

/** A thing's sentence, from its rows, and how much it stands out (for ranking). */
function sentenceOf(group: StoredMoveRate[], suffix: string) {
  const [first] = group;
  if (!first) {
    return null;
  }
  const extremity = Math.min(
    ...group.filter(isExtreme).map((r) => Math.min(r.above, r.below)),
    Number.POSITIVE_INFINITY
  );
  const sides = group.filter((r) => r.side);
  const gap =
    sides.length === 2
      ? Math.abs(
          pct((sides[0] as StoredMoveRate).all) -
            pct((sides[1] as StoredMoveRate).all)
        )
      : 0;
  const change = changeOf(group);
  const changed =
    change && Math.abs(change.points) >= CHANGE_POINTS ? change : null;
  const standsOut =
    extremity < Number.POSITIVE_INFINITY || gap >= GAP_POINTS || changed;
  if (
    !standsOut ||
    (extremity === Number.POSITIVE_INFINITY &&
      group.every((r) => shareOf(r) < LOW_SHARE))
  ) {
    return null;
  }
  const place = placeText(group);
  const trend = changed
    ? `${changed.row.side ? `${who(changed.row.side)} ` : ""}${pct(changed.row.lately)}% in the last 12 months, ${pct(changed.row.before)}% before`
    : null;
  const flag = isFlag(first);
  const head = `${LABEL[thingOf(first)]}${suffix}: ${sharesText(group)}`;
  const text = [
    flag && place ? `${head}, ${place}` : head,
    ...(flag ? [] : [place]),
    trend,
  ]
    .filter(Boolean)
    .join("; ");
  return {
    extremity,
    gap,
    points: Math.abs(changed?.points ?? 0),
    text: `- ${text}.`,
  };
}

/** The steering sentence: who tells the other what to do when something is decided, and who settles it. */
function steeringText(rows: StoredMoveRate[]) {
  const directs = rows.filter((r) => r.thing === "directs" && isShare(r));
  const decides = rows.filter((r) => r.thing === "decides" && isShare(r));
  const chances = Math.max(0, ...[...directs, ...decides].map((r) => r.all.of));
  if (directs.length === 0 || chances < DECISION_MIN) {
    return null;
  }
  const higher = directs.toSorted(
    (a, b) => shareOf(b) - shareOf(a)
  )[0] as StoredMoveRate;
  const side = who(higher.side ?? "me");
  let place = "";
  if (isExtreme(higher)) {
    place =
      higher.above <= higher.below
        ? `; only ${higher.above} of ${higher.among} other people do it more than ${side} ${side === "he" ? "does" : "do"}`
        : `; only ${higher.below} of ${higher.among} other people do it less than ${side} ${side === "he" ? "does" : "do"}`;
  }
  const [me, them] = [
    decides.find((r) => r.side === "me"),
    decides.find((r) => r.side === "them"),
  ];
  const settling =
    me && them && Math.abs(pct(me.all) - pct(them.all)) >= SETTLING_POINTS
      ? `; settling it: they in ${pct(them.all)}%, he in ${pct(me.all)}%`
      : "";
  const shares = directs
    .toSorted((a, b) => (b.side ?? "").localeCompare(a.side ?? ""))
    .map(
      (r, i) =>
        `${who(r.side ?? "me")} in ${pct(r.all)}%${i === 0 ? " of those exchanges" : ""}`
    )
    .join(", ");
  return `- ${LABEL.directs}: ${shares}${place}${settling}.`;
}

/** One sentence per side that answered a fault: "When he raised a fault (29 exchanges): they apologised in 4, ...". */
function faultTexts(rows: StoredMoveRate[]) {
  return (["them", "me"] as const).flatMap((side) => {
    const answers = rows
      .filter(
        (r) =>
          r.side === side &&
          chanceOf(r) === "fault" &&
          r.all.n >= 1 &&
          r.thing in ANSWER_VERB
      )
      .toSorted((a, b) => b.all.n - a.all.n);
    const chances = Math.max(0, ...answers.map((r) => r.all.of));
    if (answers.length === 0 || chances < FAULT_MIN) {
      return [];
    }
    const told = answers.map(
      (r, i) =>
        `${i === 0 ? `${who(side)} ` : ""}${ANSWER_VERB[r.thing as keyof typeof ANSWER_VERB]} in ${r.all.n}`
    );
    const raw = answers.some((r) => !isShare(r))
      ? " (raw counts, not proven)"
      : "";
    return [
      `- When ${who(side === "me" ? "them" : "me")} raised a fault (${chances} exchanges): ${told.join(", ")}${raw}.`,
    ];
  });
}

/**
 * What stands out of a person's stored rows, as sentences under a heading: how they steer when something is decided,
 * the other things at an extreme among people or with a big gap or change (at most `MORE`), and what each side
 * answered to the other's faults. Only the channels the table shows. Nothing when no sentence comes out.
 */
export function moveRateLines(all: StoredMoveRate[]) {
  const { shown } = channelsOf(all);
  const rows = all.filter((r) => !r.source || shown.has(r.source));
  const things = [
    ...Map.groupBy(
      rows.filter(
        (r) =>
          isShare(r) &&
          chanceOf(r) !== "fault" &&
          r.thing !== "directs" &&
          r.thing !== "decides"
      ),
      (r) => `${r.thing}|${r.source}`
    ).values(),
  ];
  const suffix = (g: StoredMoveRate[]) =>
    shown.size > 1 && g[0]?.source ? ` (${g[0].source})` : "";
  const sentences = things.flatMap((g) => sentenceOf(g, suffix(g)) ?? []);
  const extreme = sentences
    .filter((s) => s.extremity < Number.POSITIVE_INFINITY)
    .toSorted((a, b) => a.extremity - b.extremity);
  const rest = sentences.filter(
    (s) => s.extremity === Number.POSITIVE_INFINITY
  );
  const gaps = rest
    .filter((s) => s.gap >= GAP_POINTS)
    .toSorted((a, b) => b.gap - a.gap);
  const changes = rest
    .filter((s) => !gaps.includes(s))
    .toSorted((a, b) => b.points - a.points);
  const more = [...extreme, ...gaps, ...changes]
    .slice(0, MORE)
    .map((s) => s.text);
  const lines = [steeringText(rows) ?? [], ...more, ...faultTexts(rows)].flat();
  return lines.length === 0
    ? []
    : [
        '## What stands out between them and him (counted by code from their one-to-one chats; "he" is the owner)',
        ...lines,
        "",
      ];
}
