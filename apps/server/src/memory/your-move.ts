import { daysBefore } from "../core/clock";
import { LIFE_ASKER } from "../core/names";
import { isoDate } from "../records/fields";
import { readAppointments } from "./appointments";
import { locationOf, mapUrlsOf } from "./calendar-events";
import { literalOf, type Quote } from "./check-quotes";
import { saidOfLine, saidOfQuote, whereOf } from "./check-sentences";
import { plain } from "./doubts";
import { type AgentHold, isHeldOf } from "./held-matters";
import { type Check, LIFE_CHECKS } from "./life-checks";
import {
  daysFrom,
  isRunning,
  type MatterStepNow,
  type MatterView,
  nextStepNow,
} from "./matter-read";
import { needsShownOf } from "./needs";
import { dismissedIdsOf } from "./read-matters";
import type { People } from "./who";
import { dayStart } from "./zones";

// "Your move" (his yes of 21 Nov 2026): a matter's open step that is his stays in his inbox, dormant or stuck, until he
// does it or hands it to an agent; his Later on it is any check's (`deferred`). A check of Life's like the others
// (`checks.ts`), worked out when read.

/** The steps he owes that a card asks: a task of his (`to_do`), a promise; never a wait on someone, nor a to-do item (his list holds it while it is open there; Life reads it ticked or removed). */
const OWED_BY_HIM: MatterStepNow["kind"][] = ["promise", "to_do"];

/** How many days past its date a step still asks him (a deadline missed yesterday); after, it parks. */
const PAST_DATE_SHOWN_DAYS = 2;
/** How many days a matter may go without a new step before its step parks. */
const QUIET_PARK_DAYS = 30;
/** A parked step comes back for `REVIEW_DAYS` at the end of every `PARK_CYCLE_DAYS` it stays parked: "still on?". */
const PARK_CYCLE_DAYS = 30;
const REVIEW_DAYS = 3;

/** The day a step is due: its `when` as a whole date (never a yearly one); none otherwise. */
const dueOf = (when?: string) =>
  when && isoDate.safeParse(when).success ? when : undefined;

/** Its due day as the card orders and dates it: none once more than `PAST_DATE_SHOWN_DAYS` past (a step brought back by newer evidence is not due). */
const dueOn = (when: string | undefined, today: string) => {
  const due = dueOf(when);
  return due && daysFrom(due, today) <= PAST_DATE_SHOWN_DAYS ? due : undefined;
};

type MoveStep = Pick<
  MatterStepNow,
  "at" | "byMailer" | "day" | "kind" | "when"
>;

/**
 * The day a step he owes parked (held back from his inbox, never ended: it stays an open step of its matter, in
 * Matters), or none (the cognitive-load rule, his direction of 22 Nov 2026): said by a mailer (a no-reply notice or his
 * agents' report, owed to no one) from its day, dated more than `PAST_DATE_SHOWN_DAYS` ago from then, its matter quiet
 * more than `QUIET_PARK_DAYS` from then. A newer step on its matter (`newest`, its newest step's day) brings back a
 * mailer's or a past date's step; the quiet one by itself. A step due ahead (`dueOn`) never parks. Pure.
 */
function parkedSinceOf(s: MoveStep, newest: string, today: string) {
  // Due ahead, or missed in the last days: never parked.
  if (dueOn(s.when, today)) {
    return;
  }
  const due = dueOf(s.when);
  const [since] = [
    s.byMailer && newest <= s.day ? s.day : undefined,
    due && newest <= due
      ? daysBefore(due, -(PAST_DATE_SHOWN_DAYS + 1))
      : undefined,
    daysBefore(newest, -(QUIET_PARK_DAYS + 1)),
  ]
    .filter((d): d is string => d !== undefined && d <= today)
    .toSorted();
  return since;
}

/** Whether a step parked since `since` is back for review on `today`: the last `REVIEW_DAYS` of each `PARK_CYCLE_DAYS`. */
const isReviewDay = (since: string, today: string) =>
  daysFrom(since, today) % PARK_CYCLE_DAYS >= PARK_CYCLE_DAYS - REVIEW_DAYS;

/**
 * His step on a matter on `today`, what its card shows: of its open steps he owes (`OWED_BY_HIM`), those not parked (`parkedSinceOf`) or
 * back for review (`isReviewDay`), the one due first (`dueOf`), else the newest; none when nothing is his to do now,
 * with `due`, `since` (the day of the oldest of them: how long the matter has waited on him) and `review`, when the step
 * is back for review: its matter's newest step's day, since when nothing new came. Pure.
 */
export function yourMoveOf<S extends MoveStep>(
  v: { openSteps: readonly S[]; steps: readonly Pick<MatterStepNow, "day">[] },
  today: string
) {
  const newest = v.steps.reduce((d, s) => (s.day > d ? s.day : d), "");
  const his = v.openSteps
    .filter((s) => OWED_BY_HIM.includes(s.kind))
    .flatMap((s) => {
      const parked = parkedSinceOf(s, newest || s.day, today);
      return !parked || isReviewDay(parked, today)
        ? [
            {
              due: dueOn(s.when, today),
              review: parked && (newest || s.day),
              step: s,
            },
          ]
        : [];
    });
  const [first] = his.toSorted(
    (a, b) =>
      Number(a.due === undefined) - Number(b.due === undefined) ||
      (a.due ?? "").localeCompare(b.due ?? "") ||
      b.step.at.localeCompare(a.step.at)
  );
  const [since] = his.map((h) => h.step.day).toSorted();
  return first && since ? { ...first, since } : undefined;
}

/** The steps the open matters' cards show (`yourMoveOf`): whose sentences the checks read. Pure. */
export const yourMoveStepsOf = (
  matters: readonly {
    open: boolean;
    openSteps: Step[];
    steps: Pick<MatterStepNow, "day">[];
  }[],
  today: string
) =>
  matters.flatMap((v) =>
    v.open ? (yourMoveOf(v, today)?.step.ref ?? []) : []
  );

/** The place each observation an appointment was read from is at, by the observation's id; one at two places has none. Pure. */
export function placesOf(
  appointments: readonly { observations: string[]; place: string | null }[]
) {
  const at = new Map<string, string | null>();
  for (const a of appointments) {
    for (const o of a.place ? a.observations : []) {
      at.set(o, at.has(o) && at.get(o) !== a.place ? null : a.place);
    }
  }
  return new Map(
    [...at].flatMap(([o, place]) => (place ? [[o, place] as const] : []))
  );
}

/** The places of the night's appointments (`placesOf`). */
export const readPlaces = () =>
  placesOf(readAppointments()?.appointments ?? []);

type Step = Pick<
  MatterStepNow,
  "at" | "byMailer" | "day" | "kind" | "quote" | "ref" | "text" | "when"
>;

/** What the cards are worked out from: a part of the checks' inputs (`CheckInputs`). */
export interface YourMoveInputs {
  decisions: readonly { matter?: string; question: string; subject?: string }[];
  /** The matters he dismissed as new matter offers, as pinned steps: no Start on their card either. */
  dismissed: readonly (readonly string[])[];
  heldByAgents: readonly AgentHold[] | null;
  /** Whether the hand-out takes a matter: then no Start on its card (as for the new matter offer). */
  isForHandOut: (matter: string) => boolean;
  isParked: (matter: string) => boolean;
  /** Each open matter's place in his ranking (`rankedMattersOf`, as `read_matters` orders), by id: the order of the cards. */
  matterRank?: ReadonlyMap<string, number>;
  matters: readonly (Pick<
    MatterView,
    "goal" | "id" | "name" | "nextStep" | "open" | "status"
  > & {
    important?: boolean;
    /** Its open steps (`MatterView.openSteps`); none: no card. */
    openSteps?: Step[];
    steps: Pick<MatterStepNow, "at" | "day" | "ref">[];
  })[];
  /** The places of appointments by the observation they were read from (`readPlaces`). */
  places?: ReadonlyMap<string, string>;
  today: string;
}

/**
 * Each open matter whose step is his, by id: it has one (`yourMoveOf`), no open decision is on it (an agent's card
 * already asks him), its project is not parked (his own word), and no agent's open assignment holds it, or its agent
 * waits on him (`wait_owner`). A closed try holds nothing here (`isHeldOf`'s rule for the hand-out stays its own).
 * `held`: an open assignment holds it (then no Start). Pure.
 */
export function yourMovesOf(c: YourMoveInputs) {
  const isHeld = isHeldOf(
    (c.heldByAgents ?? []).filter((h) => h.closedAt === null)
  );
  return new Map(
    c.matters.flatMap((v) => {
      const move = v.open
        ? yourMoveOf({ openSteps: v.openSteps ?? [], steps: v.steps }, c.today)
        : undefined;
      const next = nextStepNow(v, c.decisions);
      const held = Boolean(isHeld(v));
      return move &&
        next?.kind !== "wait_decision" &&
        !c.decisions.some((d) => d.matter === v.id) &&
        !c.isParked(v.id) &&
        (!held || next?.kind === "wait_owner")
        ? [[v.id, { held, ...move }] as const]
        : [];
    })
  );
}

/** The last instant of the local day his step is due (`dueOf`), as a deadline; none when it has no due day. */
const deadlineOf = (due?: string) =>
  due
    ? new Date(dayStart(daysBefore(due, -1)).getTime() - 1).toISOString()
    : null;

const FULL_STOP = /\.$/;

/** What the card says beside its step: back for review, since when nothing new came; what the matter also waits on, else Life's next step when it is not the step itself. */
function contextOf(
  next: { text: string; waitsOn?: string } | undefined,
  step: string,
  review?: string
) {
  const base = review
    ? `Still on? Nothing new on it since ${plain(review)}.`
    : LIFE_CHECKS["your move"].context;
  if (next?.waitsOn) {
    return `${base} Also waiting on: ${literalOf(next.waitsOn)}.`;
  }
  return next && next.text !== step
    ? `${base} Next step: ${literalOf(next.text.replace(FULL_STOP, ""))}.`
    : base;
}

type SaidLine = Parameters<typeof saidOfLine>[0];

/**
 * The your move cards: one per matter whose step is his (`yourMovesOf`), unless it is offered as a new matter
 * (`offered`: that card asks first, until its offer ends) or his Not now hides it; its step
 * as the question and `subject`, the matter's next step and what it waits on in its context, a `place` need from an
 * appointment read from its step, its `when` as the deadline; Mark as done ends that step, Hand over starts one
 * on the matter (only while the desk is readable, no agent holds it, he did not dismiss its offer and the hand-out does
 * not take it), Not now hides it. Ranked by the matter's place in his ranking (`matterRank`), then `since`. Pure.
 */
export function yourMoveChecksOf(
  c: YourMoveInputs & {
    byId: ReadonlyMap<string, SaidLine>;
    people: Pick<People, "nameOf">;
    titles: ReadonlyMap<string, string>;
  },
  offered: ReadonlyMap<string, unknown>
) {
  const moves = yourMovesOf(c);
  const dismissed = dismissedIdsOf(c.matters, c.dismissed);
  return c.matters.flatMap((v) => {
    const move = moves.get(v.id);
    if (!move || offered.has(v.id)) {
      return [];
    }
    const { due, held, review, since, step } = move;
    const line = c.byId.get(step.ref);
    // A place name `redact` would hide part of is not shown at all.
    const place = locationOf({ name: c.places?.get(step.ref) ?? null });
    const urls = place ? mapUrlsOf({ name: place }) : undefined;
    // The hand-out takes only a running matter of his: a dormant one keeps its Start.
    const canStart =
      c.heldByAgents !== null &&
      !held &&
      !dismissed.has(v.id) &&
      !(c.isForHandOut(v.id) && isRunning(v));
    const check: Omit<Check, "confirm" | "lifeLinks" | "matter"> = {
      about: [],
      asker: LIFE_ASKER,
      at: null,
      clips: [],
      context: contextOf(v.nextStep, step.text, review),
      deadline: deadlineOf(due),
      draft: null,
      goal: v.goal?.text ?? v.name,
      group: "your move",
      kind: "your move",
      likelyPeople: [],
      links: [],
      needs: place
        ? needsShownOf([
            {
              kind: "place",
              name: place.slice(0, 120),
              ...(urls && {
                appleMapsUrl: urls.apple,
                googleMapsUrl: urls.google,
              }),
            },
          ])
        : [],
      notSent: null,
      onMatters: [],
      onSilence: null,
      options: LIFE_CHECKS["your move"].options.filter(
        (o) => o.id !== "start" || canStart
      ),
      question: step.text,
      ref: `move:${v.id}/${step.ref}`,
      ridesOn: { matterIds: [v.id], matters: 1, observations: 0, pages: 0 },
      said: line
        ? saidOfLine(line, c.people, c.titles)
        : saidOfQuote(step.quote, step.day),
      since: null,
      subject: step.ref,
      title: v.name,
    };
    const quote: Quote = {
      text: step.quote,
      unit: line?.unit,
      where: line ? whereOf(line) : plain(step.day),
    };
    return [
      {
        check,
        day: since,
        matter: v.id,
        matterRank: c.matterRank?.get(v.id),
        quote,
      },
    ];
  });
}
