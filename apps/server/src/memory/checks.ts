import { createHmac } from "node:crypto";
import { readChangeStamp } from "../core/files";
import { type CheckGroup, LIFE_ASKER } from "../core/names";
import { secretIn } from "../core/secret";
import { settings } from "../core/settings";
import { isEndingCheck } from "../records/fact-check";
import type { InferredPerson } from "../records/observation";
import { KEEP_AT } from "../records/unit";
import {
  type NamingQueueItem,
  namingQueueGuessesOf,
  readNamingQueue,
} from "../sources/lifelog-voices";
import { cardAskOf, guessAskOf } from "./check-asks";
import {
  isEndingOpen,
  type NameContext,
  nameGroupsOf,
  readSentences,
  saidOfLine,
  saidOfQuote,
  shownStepsOf,
} from "./check-sentences";
import { inboxOrderOf, type Urgency, urgencyOf } from "./check-urgency";
import { pagedNow } from "./closeness";
import {
  fixingOf,
  withComplaintFields,
  withMisreadSealed,
} from "./complaint-checks";
import {
  DECISIONS,
  type Decision,
  decisionCardOf,
  decisionsNow,
  isOnMatter,
} from "./decisions";
import { guessedOf, plain } from "./doubts";
import { withDraftConfirms } from "./draft-send";
import { type AgentHold, isHeldOf } from "./held-matters";
import {
  type BeingFixed,
  type Check,
  type CheckKind,
  type CheckMatter,
  LIFE_CHECKS,
} from "./life-checks";
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
  readUnitsWithHisWords,
  ZONES,
} from "./memory-files";
import { isLocked } from "./memory-lock";
import { withNetworkIdentities } from "./network-identity";
import { PERSON_PICTURES_INDEX } from "./party";
import {
  dismissedIdsOf,
  handOutGateOf,
  isOneOfHis,
  isParkedMatterOf,
} from "./read-matters";
import { lifeLinksOf } from "./refs";
import {
  type People,
  readPeople,
  readUnresolvedPeople,
  type Shown,
  voiceCardRefOf,
  voicePersonOf,
  voiceSuggestionOf,
} from "./who";
import { dayNow, localDate } from "./zones";

// The checks: everything waiting on his word, in one shape, with no limit. A check is one guess of Life's
// that his word would settle, shown with its evidence; it exists only while something rides on the guess (a kept line,
// an open matter, a page). Life keeps using its guess meanwhile. Or it is a decision an agent asks (`decisions.ts`),
// or a new matter Life offers an agent for ("Start an agent on this?"). Derived when read, never stored: his answer (`answerCheck`,
// `answer-check.ts`) goes to its kind's own store: a correction (a person, a new matter's goal or dismissal), a
// fact-check answer (an ending), his answer to the decision, lifelog's naming queue (a voice), or the desk (a Start).

/** A kept line as the checks read it. */
type Line = Pick<
  Shown,
  | "about"
  | "confidence"
  | "date"
  | "id"
  | "quote"
  | "speaker"
  | "subjects"
  | "text"
  | "unit"
> & { source: Pick<Shown["source"], "channel"> };

/** Where and when a record was said, in words: "whatsapp, 7 Sep". */
type Where = string;

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
  /** His complaints at work with the caretaker, by the cause each names (`causeOf`): that card shows it being fixed. */
  fixing?: ReadonlyMap<string, BeingFixed>;
  /** Every registered agent's anchors as facts (host's `heldByAgents`), for the hold rule (`isHeldOf`); null while the desk is off or unreadable: then no new matter is offered. */
  heldByAgents: readonly AgentHold[] | null;
  /** Whether a matter's next step is not checked yet (`directionDueOf`, by the matter's id): none is offered while it is due. */
  isDirectionDue: (matter: string) => boolean;
  /** Whether the hand-out takes a matter (by its id): `desk.handOut` is set and it is one of his (`isOneOfHis`); it then gets no Start. */
  isForHandOut: (matter: string) => boolean;
  /** Whether a matter (by its id) is of a parked or done project (`isParkedMatterOf`): the hand-out starts none, nor is one offered. */
  isParked: (matter: string) => boolean;
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
    important?: boolean;
    steps: Pick<MatterStepNow, "at" | "day" | "quote" | "ref">[];
  })[];
  /** What each name check shows of its sentence, by the name's key (`readNameContexts`); a name whose unit could not be read has none. */
  nameContexts: ReadonlyMap<string, NameContext>;
  /** The names Life cannot place, one group per name (`nameGroupsOf`), worked out once by the reader. */
  nameGroups: ReturnType<typeof nameGroupsOf<Line>>;
  paged: ReadonlySet<string>;
  people: Pick<
    People,
    | "ambiguousCards"
    | "candidatesFor"
    | "contacts"
    | "isGuess"
    | "nameOf"
    | "names"
    | "partyOf"
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
  /** The chat or thread a unit is in, by unit id: where a step was said (`to`); only the units the steps of endings and new matters are in. */
  titles: ReadonlyMap<string, string>;
  /** His day now (`dayNow`): a new matter is offered for `NEW_MATTER_DAYS` from its first step's day. */
  today: string;
  /** The voices lifelog asks him to name (`readNamingQueue`). */
  voices: readonly NamingQueueItem[];
  /** Where a record that is not a line was said: units and episodes, by id. */
  where: ReadonlyMap<string, Where>;
}

interface Ranked {
  /** What the guess also rests on, for its cause (`causeOf`): an ending's later step. */
  basis?: string;
  check: Omit<Check, "confirm" | "lifeLinks" | "matter">;
  /** For the order (`inboxOrderOf`): when a decision was asked, else the newest day among the lines it rides on. */
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

const whereOf = (l: Line): Where => `${l.source.channel}, ${plain(l.date)}`;

/** What every kind that shows no sentence of its own carries in the fields of `Said`. */
const NO_SAID = { said: null, since: null } as const;

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
      (r) => c.people.refOf(r)
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

function ranked(
  c: Ctx,
  group: Exclude<CheckGroup, "decision">,
  fields: Pick<Check, "about" | "question" | "ref"> & Partial<Check>,
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
            clips: fields.clips ?? [],
            contactsCard: fields.contactsCard,
            context: fields.context ?? LIFE_CHECKS[group].context,
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
            onMatters: [],
            onSilence: null,
            options: [...LIFE_CHECKS[group].options],
            question: fields.question,
            ref: fields.ref,
            ridesOn: rides,
            said: fields.said ?? null,
            since: fields.since ?? null,
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
          ...NO_SAID,
          about: [],
          agent: d.agent ?? null,
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
          onMatters: [],
          onSilence: d.onSilence,
          ...decisionCardOf(d),
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
  /** Every open step a link says ended and he has not answered, unless the link rests on his own later words. */
  ending: (c) =>
    [...c.endings].flatMap(([ref, link]) => {
      const o = c.byId.get(ref);
      const later = c.byId.get(link.later);
      return o && isEndingOpen(ref, c, later)
        ? ranked(
            c,
            "ending",
            {
              about: [],
              question: "Is this done?",
              ref,
              said: saidOfLine(o, c.people, c.titles),
              since: later
                ? saidOfLine(later, c.people, c.titles)
                : saidOfQuote(link.quote, null),
            },
            [o],
            [],
            {
              quote: link.quote,
              where: later ? whereOf(later) : c.where.get(link.later),
            }
          ).map((r) => ({ ...r, basis: link.later }))
        : [];
    }),
  /**
   * Each running matter he has not answered "Start an agent on this?" for: one that began in the last `NEW_MATTER_DAYS` (its first
   * step's day), with an open step, not stuck (a passed date), a goal and a next step to hand over (the hand-out's gates, `handOutGateOf`: not a parked project's), held
   * by no agent (`isHeldOf`: a project's agent holds only what is assigned to it), not
   * dismissed, and, while the hand-out is on, not one of his own (`isOneOfHis`: the hand-out takes those); none while the desk is off or unreadable. No deadline: it never
   * outranks an agent's decision; on silence nothing starts and it leaves after its last day.
   */
  "new matter": (c) => {
    if (!c.heldByAgents) {
      return [];
    }
    const isHeld = isHeldOf(c.heldByAgents);
    const facts = {
      decisions: c.decisions,
      dismissed: dismissedIdsOf(c.matters, c.dismissed),
      isDue: c.isDirectionDue,
      isHeld,
      isHis: () => true,
      isParked: c.isParked,
    };
    return c.matters.flatMap((v) => {
      const [first] = v.steps;
      const next = nextStepNow(v, c.decisions);
      const lastDay = offerEndOf(v);
      const firstLine = first && c.byId.get(first.ref);
      return first &&
        lastDay &&
        c.today <= lastDay &&
        v.newestOpenStep &&
        v.status !== "stuck" &&
        v.goal &&
        next &&
        !v.lone &&
        isRunning(v) &&
        handOutGateOf(v, facts) === null &&
        !c.isForHandOut(v.id)
        ? [
            {
              check: {
                ...NO_SAID,
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
                onMatters: [],
                // Nothing starts on silence: no option is taken.
                onSilence: null,
                options: [...LIFE_CHECKS["new matter"].options],
                question: "Start an agent on this?",
                ref: v.id,
                ridesOn: { ...ridingOf([v]), observations: 0, pages: 0 },
                said: firstLine
                  ? saidOfLine(firstLine, c.people, c.titles)
                  : saidOfQuote(first.quote, first.day),
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
      // One ask per person: a guess folded into another is asked through the one it folds into.
      return people.isGuess(ref) && people.refOf(ref) === ref
        ? ranked(
            c,
            "guessed person",
            {
              about: p.namesAndHandles,
              ...guessAskOf(p),
              ref,
            },
            byGuess.get(ref) ?? [],
            [ref],
            first ? { quote: first.quote, where } : null
          )
        : [];
    });
    const byRef = keptBy(c, (l) =>
      [l.about ?? "", ...l.subjects].map((r) => people.refOf(r))
    );
    const cards = people.ambiguousCards.flatMap((a) => {
      // The people its name and handles say, named once: his answer is one of them.
      const card = people.contacts.find((x) => x.id === a.card) ?? {
        handles: [],
      };
      const likelyPeople = a.people.map(people.partyOf);
      return ranked(
        c,
        "contacts card",
        {
          about: card.handles,
          likelyPeople,
          ...cardAskOf(people.nameOf(a.card), card.handles),
          ref: a.card,
        },
        byRef.get(a.card) ?? [],
        [a.card],
        null
      );
    });
    const named = c.nameGroups.flatMap(
      ({ key, last: held, lines, names: as }) => {
        const read = c.nameContexts.get(key);
        return ranked(
          c,
          "name",
          {
            about: as,
            clips: read?.clips,
            likelyPeople: people
              .candidatesFor(as[0] ?? key)
              .map(people.partyOf),
            question: `Who is "${as.join(" / ")}"?`,
            ref: `name:${key}`,
            said: read?.said ?? (held && saidOfLine(held, c.people, c.titles)),
          },
          lines,
          [],
          held ? { quote: held.quote, where: whereOf(held) } : null
        );
      }
    );
    return [...guessed, ...cards, ...named];
  },
  /** Every voice lifelog asks him to name, none left out but those he called several people (not asked in v1: one answer would give them all to one). */
  voice: (c) =>
    c.voices
      .filter((item) => item.kind !== "several")
      .map((item) => {
        const known = voiceSuggestionOf(c.people.resolve, item);
        const likely = namingQueueGuessesOf(item)
          .flatMap((id) => {
            const ref = voicePersonOf(c.people.resolve, id, null);
            return ref ? [ref] : [];
          })
          .filter((ref, i, all) => all.indexOf(ref) === i)
          .slice(0, 5)
          .map(c.people.partyOf);
        const [first] = item.evidence;
        const who = known ? c.people.nameOf(known) : null;
        return {
          check: {
            ...NO_SAID,
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
            onMatters: [],
            onSilence: null,
            // The people it could be are `likelyPeople`, lifelog's suggestion first; "Yes" only when that suggestion is in use.
            options: LIFE_CHECKS.voice.options.filter(
              (o) => who || o.id !== "is-them"
            ),
            question: who ? `Is this ${who}?` : "Who is this?",
            ref: voiceCardRefOf(c.people.resolve, item),
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

/** The checks, in his inbox's order (`inboxOrderOf`). Pure over what is stored. */
export const checksOf = (inputs: CheckInputs): Check[] => {
  const c = ctxOf(inputs);
  const matterOf = matterFinderOf(inputs.matters);
  const byId = new Map(inputs.matters.map((m) => [m.id, m]));
  const cardMatterOf = (m?: MatterId): CheckMatter | undefined =>
    m && { id: m.id, important: m.important || undefined, name: m.name };
  const found = inboxOrderOf(
    Object.values(BUILDERS)
      .flatMap((build) => build(c))
      .map(({ basis, check, day }) => {
        const card = {
          ...check,
          lifeLinks: lifeLinksOf(check.context, (id) => byId.has(id)),
          matter: cardMatterOf(matterOf([check.subject ?? check.ref])) ?? null,
          onMatters: check.ridesOn.matterIds.flatMap(
            (id) => cardMatterOf(byId.get(id)) ?? []
          ),
        };
        return { ...withComplaintFields(card, inputs.fixing, basis), day };
      })
  ).map(({ day: _, ...check }) => check);
  return withDraftConfirms(found, c.people);
};

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

/** Every file the checks read as stored (truth/ included), never units or their publications: the watcher's syncs write those every few minutes, and the checks don't read them but for an inferred person's evidence; the pictures' index. */
const CHECKS_READ = [
  ...MATTER_BOOK_READS,
  CLOSENESS,
  DECISIONS,
  PAGES,
  PERSON_PICTURES_INDEX,
  ZONES,
];

/** What registered agents hold, as the inbox reads it from the desk: a cheap stamp for the key (host's `heldStampOf`), and the facts (`heldByAgents`), read only when the list is read again; null facts when the desk can't be read then. And his complaints the caretaker holds (host's `complaintsAtWork`: a few rows, in the key). */
export interface HeldRead {
  complaints?: readonly BeingFixed[];
  read: () => readonly AgentHold[] | null;
  stamp: string;
}

/** What the checks are read from, cheaply: the files they read (`readChangeStamp`: stats, no read), his day, the open decisions (one lapses), the stamp of what agents hold and the voices lifelog queues. The same key, the same list. */
const checksKeyOf = (
  held: HeldRead | null,
  voices: readonly NamingQueueItem[],
  decisions: readonly Decision[]
) =>
  JSON.stringify([
    readChangeStamp(CHECKS_READ),
    dayNow(),
    decisions.map((d) => d.id),
    held && [held.stamp, held.complaints],
    voices,
  ]);

/** What waits on his word now, over what is stored today and `held` (`CheckInputs`; host's `openChecksNow` reads it from the desk), and its `key` (`checksKeyOf`): read-only, no model call. Read again only when the key changed, and always while a run holds the lock, then under a key never given twice (its list may change under the same files' stamp): every reader of the inbox shares one read per change, and never mutates the list. */
export async function checksAndKeyNow(held: HeldRead | null) {
  const voices = await readNamingQueue();
  const decisions = decisionsNow().filter((d) => d.state === "open");
  const key = checksKeyOf(held, voices, decisions);
  if (isLocked() || last?.key !== key) {
    const list = readChecks(held, voices, decisions);
    last = { key: isLocked() ? `${key} ${crypto.randomUUID()}` : key, list };
    list.catch(() => {
      if (last?.list === list) {
        last = undefined;
      }
    });
  }
  const read = last;
  return { checks: await read.list, key: read.key };
}

/** What waits on his word now (`checksAndKeyNow`), without its key. */
export const checksNow = async (held: HeldRead | null) =>
  (await checksAndKeyNow(held)).checks;

async function readChecks(
  held: HeldRead | null,
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
  const isParked = isParkedMatterOf(people.truth);
  const parked = new Set(matters.filter(isParked).map((v) => v.id));
  const forHandOut = new Set(
    settings().desk?.handOut
      ? matters.filter((v) => isOneOfHis(v, people)).map((v) => v.id)
      : []
  );
  const lines = records.observations;
  const kept = new Set(
    lines
      .filter((o) => o.importance >= KEEP_AT && !records.retired.has(o.id))
      .map((o) => o.id)
  );
  const answered = new Set(
    [...readFactCheckAnswers()].flatMap(([ref, a]) => (a.answer ? [ref] : []))
  );
  const doubted = new Set(
    readFactChecks().flatMap((s) => (isEndingCheck(s) ? [] : [s.ref]))
  );
  const nameGroups = nameGroupsOf({
    hisUnitsOf: readUnitsWithHisWords,
    kept,
    lines,
    people,
    unresolved,
  });
  const today = dayNow();
  const steps = shownStepsOf({
    answered,
    doubted,
    endings: records.linkEndings,
    lines,
    matters,
    today,
  });
  const { nameContexts, titles, units } = await readSentences({
    lines,
    names: nameGroups,
    people,
    steps,
  });
  const key = secretIn("pushIdKey");
  const checks = checksOf({
    answered,
    decisions,
    dismissed: readDismissedMatterPins(),
    doubted,
    endings: records.linkEndings,
    fixing: fixingOf(held?.complaints ?? []),
    heldByAgents: held?.read() ?? null,
    isDirectionDue: directionDueOf(matters, records, dayNow()),
    isForHandOut: (id) => forHandOut.has(id),
    isParked: (id) => parked.has(id),
    // Kept: shown, not retired, at or above KEEP_AT (what `observationStatusOf` calls active).
    kept,
    lines,
    matters,
    nameContexts,
    nameGroups,
    paged,
    people,
    titles,
    today,
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
  return inboxChecksOf(await withNetworkIdentities(checks, people), key);
}

/** The inbox's cards as finally shown (their network identities attached): with their push ids and urgency, then their "Wrong…" sealed on all of it (`withMisreadSealed`). */
export const inboxChecksOf = (identified: readonly Check[], key: string) =>
  withMisreadSealed(
    identified.map((c) => ({
      ...c,
      contactsCard: c.contactsCard ?? null,
      pushId: pushIdOf(c.ref, key),
      urgency: urgencyOf(c),
    })),
    key
  );
