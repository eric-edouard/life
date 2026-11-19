import { createHmac } from "node:crypto";
import { readChangeStamp } from "../core/files";
import { LIFE_ASKER, type SourceName } from "../core/names";
import { secretIn } from "../core/secret";
import { isEndingCheck } from "../records/fact-check";
import type { InferredPerson, Unresolved } from "../records/observation";
import { KEEP_AT } from "../records/unit";
import {
  type NamingQueueItem,
  namingQueueGuessesOf,
  readNamingQueue,
} from "../sources/lifelog-voices";
import {
  blockingCountOf,
  inboxRankOf,
  type Urgency,
  urgencyOf,
} from "./check-urgency";
import { pagedNow } from "./closeness";
import {
  DECISIONS,
  type Decision,
  decisionsNow,
  isOnMatter,
  notSentOf,
} from "./decisions";
import { guessedOf, plain } from "./doubts";
import type { StoredDraft } from "./draft";
import { type CheckGroup, type CheckOption, LIFE_CHECKS } from "./life-checks";
import {
  directionDueOf,
  isRunning,
  type MatterStepNow,
  type MatterView,
  matterBookOf,
  matterFinderOf,
  matterPeopleOf,
  nextStepNow,
  offerEndOf,
} from "./matter-read";
import {
  MATTER_BOOK_READS,
  mattersNow,
  readMatterRecords,
  readMatters,
} from "./matters";
import {
  CLOSENESS,
  PAGES,
  readDismissedMatterPins,
  readFactCheckAnswers,
  readFactChecks,
  readUnitsFor,
  ZONES,
} from "./memory-files";
import { isLocked } from "./memory-lock";
import { sourceOf } from "./sources";
import { nameKey } from "./units";
import {
  type People,
  readPeople,
  readUnresolvedPeople,
  type Shown,
  voicePersonOf,
} from "./who";
import { dayNow, localDate } from "./zones";

// The checks: everything waiting on his word, in one shape, with no limit. A check is one guess of Life's
// that his word would settle, shown with its evidence; it exists only while something rides on the guess (a kept line,
// an open matter, a page). Life keeps using its guess meanwhile. Or it is a decision an agent asks (`decisions.ts`),
// or a new matter Life offers an agent for ("Work on it?"). Derived when read, never stored: his answer (`answerCheck`,
// `answer-check.ts`) goes to its kind's own store: a correction (a person, a new matter's goal or dismissal), a
// fact-check answer (an ending), his answer to the decision, lifelog's naming queue (a voice), or the desk (a Start).

type CheckKind = "decision" | "ending" | "new matter" | "person" | "voice";
/**
 * One thing waiting on his word, the same shape for every kind: Life's guesses and agents' decisions alike. A field
 * a kind has nothing for is null or empty. Only open checks exist: his answer and what came of it are kept by each
 * kind's own store (`decisionsNow`, the fact-check answers, the corrections).
 */
export interface Check {
  /** The names and handles the question is about, as his answer takes them (`nameOrHandle`); none but a person's. */
  about: string[];
  /** Who asks: `life` for Life's own guesses, else the agent's pairing or `desk`. */
  asker: string;
  /** When it was asked; null for Life's guesses (worked out when read). */
  at: string | null;
  /** A voice's spans of recording (`audio` is what the app plays from lifelog), newest first as lifelog gives them; none but a voice's. */
  clips: {
    at: string | null;
    audio: { end: number; jobId: string; start: number } | null;
    text: string;
    until: string | null;
    /** Its words as lifelog times them (`TimedWords`): [start, end, length] each, in ms from the clip's start and UTF-16 units of `text` with the spacing before it, for lighting them while it plays. */
    words: number[][];
  }[];
  /** The guess about who a decision's draft goes to, when Life only guesses who that is: asked beside it, answered on its own; none for every other check. */
  confirm: Check[];
  /** Why it asks, what was tried, what it rests on: folded on his card. An agent's words, or Life's own for its guesses. */
  context: string | null;
  /** By when he answers; null: no deadline. */
  deadline: string | null;
  /** The exact message he approves (to whom, on which channel, its text), shown in full; null: none. */
  draft: StoredDraft | null;
  /** The quoted words a guess of Life's rests on, with where and when they were said; null for a card or a decision. */
  evidence: { from: string; quote: string } | null;
  /** A new matter's goal, the one his Start hands the agent (the question words it too); null for every other kind. */
  goal: string | null;
  group: CheckGroup;
  kind: CheckKind;
  /** Who it may be, as Life knows them: a voice's likely people, a Contacts card's candidates; none for other kinds. */
  likelyPeople: { name: string; person: string }[];
  /** Where to look or act (the agent's link first). */
  links: string[];
  /** The matter it belongs to: the one holding its `subject`, else its `ref` (`matterFinderOf`), closed ones too (an ending check is about a matter that reads probably done); null: none. */
  matter: { id: string; name: string } | null;
  /** A decision whose draft his last answer did not send (nothing went): when, why, and whether the same tap could work again; null: none. */
  notSent: { at: string; canRetry: boolean; reason: string } | null;
  /** The option the agent takes when he does not answer; null: none is taken (Life keeps using its guess, never writing it). */
  onSilence: string | null;
  /** What he can answer (`CheckOption`: his button's label and what his answer takes); with two or more, the first is the one recommended (Life: its guess). Besides them he can always answer in his own words (a decision's `note`, else `tell_life`). */
  options: CheckOption[];
  /** What he decides, in one sentence (a guess's worded by a template, no model). */
  question: string;
  /** What his answer acts on: a decision's id, an observation id (ending), a person ref (a guessed person, a card), or `name:<nameKey>` (a name not placed). */
  ref: string;
  /** What uses it today, counted from what is stored. */
  ridesOn: {
    /** The ids of those matters (`matters` counts them): `checksOnMatterOf` finds a matter's checks by them. */
    matterIds: string[];
    // ponytail: remove `matters` once the phone build that reads `matterIds` ships; installed builds need it to decode.
    matters: number;
    observations: number;
    pages: number;
  };
  /** What in his life it belongs to, when not `ref` itself: a matter step, `project:<id>`, `area:<id>`; for a voice, the person lifelog suggests; null: none. */
  subject: string | null;
  /** What it is trying to do, in one line. */
  title: string;
}

/** A kept line as the checks read it. */
type Line = Pick<
  Shown,
  | "about"
  | "confidence"
  | "date"
  | "id"
  | "quote"
  | "subjects"
  | "text"
  | "unit"
> & { source: Pick<Shown["source"], "channel"> };

/** Where and when a record was said, in words: "whatsapp, 7 Sep". */
type Where = string;

/** What registered agents hold now (host's `heldByAgents`): the matter steps they are anchored on and the projects they work on. */
export interface HeldByAgents {
  projects: ReadonlySet<string>;
  steps: ReadonlySet<string>;
}

/** Everything the checks are worked out from; `checksNow` reads it, `checksOf` is pure over it. */
export interface CheckInputs {
  /** Refs of the fact-check answers he gave (any answer settles that line's check). */
  answered: ReadonlySet<string>;
  /** The open decisions (`decisionsNow`). */
  decisions: readonly Decision[];
  /** The matters he dismissed as new matter checks, each as the steps it was pinned to (`readDismissedMatterPins`). */
  dismissed: readonly (readonly string[])[];
  /** Refs of the old doubt lines drawn before 14 Nov 2026 (stored fact checks that are not ending checks): an answer by ref would land on them. */
  doubted: ReadonlySet<string>;
  /** Each step a link ended, not yet his word (`endingsRead`): it reads probably ended until he answers. */
  endings: ReadonlyMap<string, { later: string; quote: string }>;
  /** The steps registered agents are anchored on and the projects they work on, in any status (from host); null while the desk is off or unreadable: then no new matter is offered. */
  heldByAgents: HeldByAgents | null;
  /** Whether a matter's next step is not checked yet (`directionDueOf`, by the matter's id): none is offered while it is due. */
  isDirectionDue: (matter: string) => boolean;
  /** Every observation that shows, and the ids of those that are kept: active, at or above `KEEP_AT`. */
  kept: ReadonlySet<string>;
  lines: readonly Line[];
  matters: readonly (Pick<
    MatterView,
    | "goal"
    | "id"
    | "lone"
    | "name"
    | "newestOpenStep"
    | "nextStep"
    | "open"
    | "owedTo"
    | "projects"
    | "status"
    | "waitingOn"
    | "with"
  > & {
    steps: Pick<MatterStepNow, "day" | "quote" | "ref">[];
  })[];
  paged: ReadonlySet<string>;
  people: Pick<
    People,
    | "ambiguousCards"
    | "contacts"
    | "isGuess"
    | "nameOf"
    | "names"
    | "refOf"
    | "resolve"
  > & {
    inferred: Pick<
      InferredPerson,
      | "at"
      | "confidence"
      | "evidence"
      | "id"
      | "name"
      | "namesAndHandles"
      | "relation"
    >[];
  };
  /** His day now (`dayNow`): a new matter is offered for `NEW_MATTER_DAYS` from its first step's day. */
  today: string;
  unresolved: readonly Pick<Unresolved, "nameAsWritten" | "observation">[];
  /** The voices lifelog asks him to name (`readNamingQueue`). */
  voices: readonly NamingQueueItem[];
  /** Where a record that is not a line was said: units and episodes, by id. */
  where: ReadonlyMap<string, Where>;
}

interface Ranked {
  check: Omit<Check, "confirm" | "matter">;
  /** The newest day among the lines it rides on, for the order. */
  day: string;
}

type MatterId = CheckInputs["matters"][number];

/** `CheckInputs` with the lookups every builder shares, made once. */
interface Ctx extends CheckInputs {
  byId: ReadonlyMap<string, Line>;
  /** Every step any matter holds, open or not. */
  matterSteps: ReadonlySet<string>;
  /** The open matters holding a step, by the step's ref, and involving a person, by the person's ref. */
  mattersByPerson: ReadonlyMap<string, Set<MatterId>>;
  mattersByStep: ReadonlyMap<string, Set<MatterId>>;
}

function ctxOf(c: CheckInputs): Ctx {
  const mattersByStep = new Map<string, Set<MatterId>>();
  const mattersByPerson = new Map<string, Set<MatterId>>();
  const add = (by: Map<string, Set<MatterId>>, ref: string, m: MatterId) =>
    by.set(ref, (by.get(ref) ?? new Set()).add(m));
  for (const m of c.matters.filter((x) => x.open)) {
    for (const s of m.steps) {
      add(mattersByStep, s.ref, m);
    }
    for (const r of matterPeopleOf(m)) {
      add(mattersByPerson, r, m);
    }
  }
  return {
    ...c,
    byId: new Map(c.lines.map((l) => [l.id, l])),
    matterSteps: new Set(c.matters.flatMap((m) => m.steps.map((s) => s.ref))),
    mattersByPerson,
    mattersByStep,
  };
}

/** A goal's own full stop, dropped before the question adds its own. */
const FINAL_STOP = /\.$/;

/** The guess of an ending check, in one place: the builder shows it and his answer stores it. */
export const endingGuessOf = (step: string) =>
  `Life thinks this is done: ${step}`;

/** Whether an open step with an ending found is an ending check: no old doubt line holds its ref, he has not answered. */
export const isEndingOpen = (
  ref: string,
  c: Pick<CheckInputs, "answered" | "doubted">
) => !(c.doubted.has(ref) || c.answered.has(ref));

/** An ending check always has its evidence: the later step's words. */
export const isEndingKind = (
  c: Check
): c is Check & { evidence: NonNullable<Check["evidence"]> } =>
  c.kind === "ending";

const whereOf = (l: Line): Where => `${l.source.channel}, ${plain(l.date)}`;

/** The open matters something rides on: their ids and how many. */
const ridingOf = (matters: Iterable<MatterId> = []) => {
  const matterIds = [...matters].map((m) => m.id);
  return { matterIds, matters: matterIds.length };
};

/** What rides on a guess: the kept `lines` using it, the open matters holding one of them or one of `refs`, the pages they show on. */
function ridesOn(c: Ctx, lines: Line[], refs: string[]) {
  const matters = new Set([
    ...lines.flatMap((l) => [...(c.mattersByStep.get(l.id) ?? [])]),
    ...refs.flatMap((r) => [...(c.mattersByPerson.get(r) ?? [])]),
  ]);
  const shownOn = new Set(
    [...refs, ...lines.flatMap((l) => [l.about ?? "", ...l.subjects])].map(
      c.people.refOf
    )
  );
  return {
    ...ridingOf(matters),
    observations: lines.filter((l) => c.kept.has(l.id)).length,
    pages: [...shownOn].filter((r) => c.paged.has(r)).length,
  };
}

/** The kept lines each ref in `refsOf(line)` appears in. */
const keptBy = (c: Ctx, refsOf: (l: Line) => string[]) => {
  const by = new Map<string, Line[]>();
  for (const l of c.lines) {
    for (const ref of c.kept.has(l.id) ? refsOf(l) : []) {
      by.set(ref, [...(by.get(ref) ?? []), l]);
    }
  }
  return by;
};

const newest = (lines: Line[]) =>
  lines.reduce((m, l) => (l.date > m.date ? l : m));

function ranked(
  c: Ctx,
  group: Exclude<CheckGroup, "decision">,
  fields: Pick<Check, "about" | "question" | "ref"> &
    Partial<Pick<Check, "likelyPeople">>,
  lines: Line[],
  refs: string[],
  evidence: { quote: string; where?: Where } | null
): Ranked[] {
  const rides = ridesOn(c, lines, refs);
  const kind = group === "ending" ? "ending" : "person";
  return rides.matters + rides.observations > 0
    ? [
        {
          check: {
            about: fields.about,
            asker: LIFE_ASKER,
            at: null,
            clips: [],
            context: LIFE_CHECKS[group].context,
            deadline: null,
            draft: null,
            evidence: evidence && {
              from: evidence.where ?? "an earlier message",
              quote: evidence.quote,
            },
            goal: null,
            group,
            kind,
            likelyPeople: fields.likelyPeople ?? [],
            links: [],
            notSent: null,
            onSilence: null,
            options: [...LIFE_CHECKS[group].options],
            question: fields.question,
            ref: fields.ref,
            ridesOn: rides,
            subject: null,
            title: LIFE_CHECKS[group].title,
          },
          day: lines.reduce((m, l) => (l.date > m ? l.date : m), ""),
        },
      ]
    : [];
}

/** Each kind of check, from what is stored. A new kind (a voice, a tie, an appointment, a line with a doubt of its own) is one more entry. */
const BUILDERS: Record<CheckKind, (c: Ctx) => Ranked[]> = {
  /** Every open decision; one on a matter step leaves once the matters holding it have all ended (a step no matter holds now, after a re-group, keeps it). */
  decision: (c) =>
    c.decisions
      .filter(
        (d) =>
          !isOnMatter(d.subject) ||
          c.mattersByStep.has(d.subject) ||
          !c.matterSteps.has(d.subject)
      )
      .map((d) => ({
        check: {
          about: [],
          asker: d.asker,
          at: d.at,
          clips: [],
          context: d.context || null,
          deadline: d.deadline,
          draft: d.draft ?? null,
          evidence: null,
          goal: null,
          group: "decision",
          kind: "decision",
          likelyPeople: [],
          links: d.links,
          notSent: notSentOf(d),
          onSilence: d.onSilence,
          options: d.options.map((o) => ({ ...o, takes: null })),
          question: d.question,
          ref: d.id,
          ridesOn: {
            ...ridingOf(
              isOnMatter(d.subject) ? c.mattersByStep.get(d.subject) : []
            ),
            observations: 0,
            pages: 0,
          },
          subject: d.subject ?? null,
          title: d.title,
        },
        day: d.at,
      })),
  /** Every open step a link says ended and he has not answered. */
  ending: (c) =>
    [...c.endings].flatMap(([ref, link]) => {
      const o = c.byId.get(ref);
      const later = c.byId.get(link.later);
      return o && isEndingOpen(ref, c)
        ? ranked(
            c,
            "ending",
            {
              about: [],
              question: endingGuessOf(o.text),
              ref,
            },
            [o],
            [],
            {
              quote: link.quote,
              where: later ? whereOf(later) : c.where.get(link.later),
            }
          )
        : [];
    }),
  /**
   * Each running matter he has not answered "Work on it?" for: one that began in the last `NEW_MATTER_DAYS` (its first
   * step's day), with an open step, not stuck (a passed date), a goal and a next step he could hand over (`do`, read
   * through `nextStepNow`) that is checked (not `isDirectionDue`: a step an outside record may have overtaken waits for
   * its redraft), no registered agent anchored on it or holding its project, and not dismissed; none while the desk is off or unreadable. No deadline: it never outranks an agent's decision; on silence nothing starts and it leaves after its
   * last day.
   */
  "new matter": (c) => {
    const held = c.heldByAgents;
    if (!held) {
      return [];
    }
    const find = matterFinderOf(c.matters);
    const dismissed = new Set(c.dismissed.map(find));
    return c.matters.flatMap((v) => {
      const [first] = v.steps;
      const next = nextStepNow(v, c.decisions);
      const lastDay = offerEndOf(v);
      return first &&
        lastDay &&
        c.today <= lastDay &&
        v.newestOpenStep &&
        v.status !== "stuck" &&
        v.goal &&
        next?.kind === "do" &&
        !v.lone &&
        isRunning(v) &&
        !dismissed.has(v) &&
        !v.steps.some((s) => held.steps.has(s.ref)) &&
        !v.projects.some((p) => held.projects.has(p)) &&
        !c.isDirectionDue(v.id)
        ? [
            {
              check: {
                about: [],
                asker: LIFE_ASKER,
                at: null,
                clips: [],
                context: `${LIFE_CHECKS["new matter"].context} Next step: ${next.text}. Asked until ${plain(lastDay)}.`,
                deadline: null,
                draft: null,
                evidence: { from: plain(first.day), quote: first.quote },
                goal: v.goal.text,
                group: "new matter",
                kind: "new matter",
                likelyPeople: [],
                links: [],
                notSent: null,
                // Nothing starts on silence: no option is taken.
                onSilence: null,
                options: [...LIFE_CHECKS["new matter"].options],
                question: `Goal: ${v.goal.text.replace(FINAL_STOP, "")}. Work on it?`,
                ref: v.id,
                ridesOn: { ...ridingOf([v]), observations: 0, pages: 0 },
                subject: null,
                title: `${LIFE_CHECKS["new matter"].title}: ${v.name}`,
              },
              day: first.day,
            },
          ]
        : [];
    });
  },
  /** The three guesses about who someone is: a guessed person, a Contacts card Life cannot place, a name it cannot place. */
  person: (c) => {
    const { people } = c;
    const byGuess = keptBy(c, (l) => guessedOf(l, people));
    const guessed = [
      ...new Map(people.inferred.map((p) => [p.id, p])).values(),
    ].flatMap((p) => {
      const ref = `person:${p.id}`;
      const [first] = p.evidence;
      const where = first && c.where.get(first.unit);
      return people.isGuess(ref)
        ? ranked(
            c,
            "guessed person",
            {
              about: p.namesAndHandles,
              question: `Life thinks this is ${p.name}, ${p.relation} (${Math.round(p.confidence * 100)}% sure)`,
              ref,
            },
            byGuess.get(ref) ?? [],
            [ref],
            first ? { quote: first.quote, where } : null
          )
        : [];
    });
    const byRef = keptBy(c, (l) =>
      [l.about ?? "", ...l.subjects].map(people.refOf)
    );
    const cards = people.ambiguousCards.flatMap((a) => {
      // The people its name and handles say, named once: his answer is one of them.
      const likelyPeople = a.people.map((p) => ({
        name: people.nameOf(p),
        person: p,
      }));
      return ranked(
        c,
        "contacts card",
        {
          about: people.contacts.find((x) => x.id === a.card)?.handles ?? [],
          likelyPeople,
          question: `Life cannot place the Contacts card ${people.nameOf(a.card)}: its name and handles say ${likelyPeople.map((p) => p.name).join(" and ")}`,
          ref: a.card,
        },
        byRef.get(a.card) ?? [],
        [a.card],
        null
      );
    });
    const open = c.unresolved.filter(
      (r) => r.observation && !people.resolve(r.nameAsWritten)
    );
    const names = [
      ...Map.groupBy(open, (r) => nameKey(r.nameAsWritten) || r.nameAsWritten),
    ].flatMap(([key, rows]) => {
      const lines = [...new Set(rows.map((r) => r.observation))].flatMap(
        (id) => {
          const l = id ? c.byId.get(id) : undefined;
          return l && c.kept.has(l.id) ? [l] : [];
        }
      );
      const last = lines.length > 0 ? newest(lines) : undefined;
      return ranked(
        c,
        "name",
        {
          about: [...new Set(rows.map((r) => r.nameAsWritten))],
          question: `Life cannot tell who "${[...new Set(rows.map((r) => r.nameAsWritten))].join(" / ")}" is`,
          ref: `name:${key}`,
        },
        lines,
        [],
        last ? { quote: last.quote, where: whereOf(last) } : null
      );
    });
    return [...guessed, ...cards, ...names];
  },
  /** Every voice lifelog asks him to name, none left out but those he called several people (not asked in v1: one answer would give them all to one). */
  voice: (c) =>
    c.voices
      .filter((item) => item.kind !== "several")
      .map((item) => {
        const known = voicePersonOf(c.people.resolve, item.personId, item.name);
        const likely = namingQueueGuessesOf(item)
          .flatMap((id) => {
            const ref = voicePersonOf(c.people.resolve, id, null);
            return ref ? [ref] : [];
          })
          .filter((ref, i, all) => all.indexOf(ref) === i)
          .slice(0, 5)
          .map((ref) => ({ name: c.people.nameOf(ref), person: ref }));
        const [first] = item.evidence;
        const who =
          known && item.kind !== "new_person" ? c.people.nameOf(known) : null;
        return {
          check: {
            about: item.name ? [item.name] : [],
            asker: LIFE_ASKER,
            at: null,
            clips: item.clips,
            context: `${LIFE_CHECKS.voice.context} Heard in ${item.conversations} conversations, ${item.words} words.`,
            deadline: null,
            draft: null,
            evidence: first
              ? {
                  from: `a recorded conversation, ${first.at ? plain(localDate(first.at)) : "date unknown"}`,
                  quote: first.text,
                }
              : null,
            goal: null,
            group: "voice",
            kind: "voice",
            likelyPeople: likely,
            links: [],
            notSent: null,
            onSilence: null,
            // His first answer is lifelog's suggestion (or the name it heard) by first name; `likelyPeople` ranks everyone, so it names no one.
            options: LIFE_CHECKS.voice.options.map((o, i) =>
              i === 0
                ? { ...o, label: (who ?? item.name)?.split(" ")[0] ?? o.label }
                : o
            ),
            question: "Who is this?",
            ref: `voice:${item.id}`,
            ridesOn: { ...ridingOf(), observations: 0, pages: 0 },
            // The person lifelog suggests, what makes it a guess in use; null: none (`urgencyOf`).
            subject: who ? known : null,
            title: LIFE_CHECKS.voice.title,
          },
          day: item.clips.reduce(
            (m, k) => (k.at && localDate(k.at) > m ? localDate(k.at) : m),
            ""
          ),
        };
      }),
};

/** The checks: in his inbox's order (`inboxRankOf`); inside a rank, those with a deadline first (an agent's decisions), soonest first; then most load-bearing first: matters, then lines, then pages, then newest. Pure over what is stored. */
export const checksOf = (inputs: CheckInputs): Check[] => {
  const c = ctxOf(inputs);
  const matterOf = matterFinderOf(inputs.matters);
  const found = Object.values(BUILDERS)
    .flatMap((build) => build(c))
    .toSorted(
      (a, b) =>
        inboxRankOf(a.check) - inboxRankOf(b.check) ||
        Number(b.check.deadline !== null) - Number(a.check.deadline !== null) ||
        (a.check.deadline ?? "").localeCompare(b.check.deadline ?? "") ||
        b.check.ridesOn.matters - a.check.ridesOn.matters ||
        b.check.ridesOn.observations - a.check.ridesOn.observations ||
        b.check.ridesOn.pages - a.check.ridesOn.pages ||
        b.day.localeCompare(a.day) ||
        a.check.ref.localeCompare(b.check.ref)
    )
    .map(({ check }) => {
      const m = matterOf([check.subject ?? check.ref]);
      return { ...check, matter: m ? { id: m.id, name: m.name } : null };
    });
  const guessed = new Map(
    found
      .filter((x) => x.group === "guessed person")
      .map((x) => [c.people.refOf(x.ref), { ...x, confirm: [] }])
  );
  return found.map((x) => {
    const person = x.draft && draftPersonOf(c, x.draft);
    const guess = person && guessed.get(c.people.refOf(person));
    return { ...x, confirm: guess ? [guess] : [] };
  });
};

/**
 * Who a decision's draft goes to, as a person ref: its stored chat's handle (its source's `handleOf`), or a mail's `to`,
 * read through `resolve`. Null for a source whose chat keys hold no handle, a draft not yet resolved to a chat, or a
 * handle no one has.
 */
function draftPersonOf(c: Ctx, d: StoredDraft) {
  const source = d.channel ? sourceOf(d.channel as SourceName) : undefined;
  const handle =
    source?.kind === "mail" ? d.to : d.chat && source?.handleOf?.(d.chat);
  return handle ? c.people.resolve(handle) : null;
}

/** The checks about matter `id`: every kind, open matters they ride on and the one holding their subject (an ending is about a matter that reads probably done). */
export const checksOnMatterOf = <C extends Pick<Check, "matter" | "ridesOn">>(
  list: readonly C[],
  id: string
) =>
  list.filter((c) => c.matter?.id === id || c.ridesOn.matterIds.includes(id));

/** A card's id for a push: 16 hex of an HMAC of its ref under a key that never leaves the Mac. The phone matches it against the inbox; it is never the ref. */
export const pushIdOf = (ref: string, key = secretIn("pushIdKey")) =>
  createHmac("sha256", key).update(ref).digest("hex").slice(0, 16);

/** A check as the inbox lists it: with its `pushId` and its `urgency`. */
export type InboxCheck = Check & { pushId: string; urgency: Urgency };

/** The last list `checksNow` read, and what it was read from (`checksKeyOf`). */
let last: { key: string; list: Promise<InboxCheck[]> } | undefined;

/**
 * Every file the checks read as stored (truth/ included), never units or their publications: the watcher's syncs write
 * those every few minutes, and the checks don't read them but for an inferred person's evidence (where it was said).
 */
const CHECKS_READ = [...MATTER_BOOK_READS, CLOSENESS, DECISIONS, PAGES, ZONES];

/**
 * What the checks are read from, cheaply: the files they read (`readChangeStamp`: stats, no read), his day, the open
 * decisions (one lapses), what agents hold (their steps and projects) and the voices lifelog queues. The same key, the same list.
 */
const checksKeyOf = (
  held: HeldByAgents | null,
  voices: readonly NamingQueueItem[],
  decisions: readonly Decision[]
) =>
  JSON.stringify([
    readChangeStamp(CHECKS_READ),
    dayNow(),
    decisions.map((d) => d.id),
    held && [[...held.steps].sort(), [...held.projects].sort()],
    voices,
  ]);

/**
 * What waits on his word now, over what is stored today and `held` (`CheckInputs`; host's `openChecksNow` reads it from
 * the desk): read-only, no model call. Read again only when what it is read from changed (`checksKeyOf`), and always
 * while a run holds the lock: every reader of the inbox shares one read per change, and never mutates the list.
 */
export async function checksNow(
  held: HeldByAgents | null
): Promise<InboxCheck[]> {
  const voices = await readNamingQueue();
  const decisions = decisionsNow().filter((d) => d.state === "open");
  if (isLocked()) {
    return await readChecks(held, voices, decisions);
  }
  const key = checksKeyOf(held, voices, decisions);
  if (last?.key !== key) {
    const list = readChecks(held, voices, decisions);
    last = { key, list };
    list.catch(() => {
      if (last?.list === list) {
        last = undefined;
      }
    });
  }
  return await last.list;
}

async function readChecks(
  held: HeldByAgents | null,
  voices: NamingQueueItem[],
  decisions: Decision[]
): Promise<InboxCheck[]> {
  const people = await readPeople();
  const [records, unresolved, paged] = await Promise.all([
    readMatterRecords(people),
    readUnresolvedPeople(),
    pagedNow(people),
  ]);
  const matters = matterBookOf(mattersNow(readMatters()), records, dayNow());
  const units = readUnitsFor(
    people.inferred.flatMap((p) => p.evidence.map((e) => e.unit))
  );
  const key = secretIn("pushIdKey");
  const checks = checksOf({
    answered: new Set(
      [...readFactCheckAnswers()].flatMap(([ref, a]) => (a.answer ? [ref] : []))
    ),
    decisions,
    dismissed: readDismissedMatterPins(),
    doubted: new Set(
      readFactChecks()
        .filter((s) => !isEndingCheck(s))
        .map((s) => s.ref)
    ),
    endings: records.linkEndings,
    heldByAgents: held,
    isDirectionDue: directionDueOf(matters, records, dayNow()),
    // Kept: shown, not retired, at or above KEEP_AT (what `observationStatusOf` calls active).
    kept: new Set(
      records.observations
        .filter((o) => o.importance >= KEEP_AT && !records.retired.has(o.id))
        .map((o) => o.id)
    ),
    lines: records.observations,
    matters,
    paged,
    people,
    today: dayNow(),
    unresolved,
    voices,
    where: new Map([
      ...units.map((u): [string, Where] => [
        u.id,
        `${u.source}, ${plain(u.date)}`,
      ]),
      ...records.episodes.map((m): [string, Where] => [
        m.id,
        `an episode, ${plain(m.day)}`,
      ]),
    ]),
  });
  return checks.map((c) => ({
    ...c,
    pushId: pushIdOf(c.ref, key),
    urgency: urgencyOf(c),
  }));
}

/** What the inbox holds: how many of each group, how many in all, how many block (the badge), and how many are due by the end of his day (`dayNow`). */
export const inboxOf = (list: Check[]) => ({
  blocking: blockingCountOf(list),
  counts: Object.fromEntries(
    [...Map.groupBy(list, (c) => c.group)].map(([g, l]) => [g, l.length])
  ),
  deadlinesToday: list.filter(
    (c) => c.deadline && localDate(c.deadline) <= dayNow()
  ).length,
  total: list.length,
});
