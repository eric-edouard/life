import { readChangeStamp } from "../core/files";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { LIFE_ASKER } from "../core/names";
import { secretIn } from "../core/secret";
import { settings } from "../core/settings";
import { answerIconOf } from "../records/answer-icon";
import { isEndingCheck } from "../records/fact-check";
import { KEEP_AT } from "../records/unit";
import { readContactStores } from "../sources/contacts";
import { pushIdOf } from "../sources/lifelog-push";
import { readNamingQueue } from "../sources/lifelog-voices";
import {
  atOrganizationAsksOf,
  readAtOrganizationPairs,
} from "./at-organization";
import { planRoleOf } from "./card-problems";
import { cardAskOf, guessAskOf } from "./check-asks";
import {
  type CheckInputs,
  type Ctx,
  ctxOf,
  keptBy,
  type MatterId,
  NO_SAID,
  type Ranked,
  ranked,
  ridingOf,
  type Where,
} from "./check-context";
import { literalOf, withQuoteOf } from "./check-quotes";
import {
  isEndingOpen,
  nameGroupsOf,
  readSentences,
  saidOfLine,
  saidOfQuote,
  shownStepsOf,
  whereOf,
} from "./check-sentences";
import { inboxOrderOf, type Urgency, urgencyOf } from "./check-urgency";
import { pagedNow } from "./closeness";
import { fixingOf, withComplaintFields } from "./complaint-checks";
import { DECISIONS, type Decision, doneSeenShownOf } from "./decision-lines";
import { decisionsNow, doneSeenByOf, isOnMatter, notSentOf } from "./decisions";
import { guessedOf, plain } from "./doubts";
import { withDraftConfirms } from "./draft-send";
import {
  type CardHolders,
  type Check,
  type CheckKind,
  type CheckMatter,
  type HeldRead,
  LIFE_CHECKS,
} from "./life-checks";
import {
  directionDueOf,
  isAwaitingHisWord,
  matterBookOf,
  matterFinderOf,
} from "./matter-read";
import {
  MATTER_BOOK_READS,
  mattersNow,
  readMatterRecords,
  readMatters,
} from "./matters";
import {
  APPOINTMENTS,
  CLOSENESS,
  PAGES,
  readDismissedMatterPins,
  readFactCheckAnswers,
  readFactChecks,
  readUnitsWithHisWords,
  ZONES,
} from "./memory-files";
import { isLocked } from "./memory-lock";
import { needsShownOf } from "./needs";
import { withNetworkIdentities } from "./network-identity";
import { PERSON_PICTURES_INDEX } from "./party";
import { PROJECT_SITUATIONS } from "./project-situation-read";
import { isOneOfHis, isParkedMatterOf } from "./read-matters";
import { rankContextOf, rankedMattersOf } from "./read-open-items";
import { lifeLinksOf } from "./refs";
import { samePersonAsksOf, samePersonPairsOf } from "./same-person";
import { voiceChecksOf } from "./voice-checks";
import { withVoiceGuesses } from "./voice-guesses";
import { readPeople, readUnresolvedPeople } from "./who";
import { readPlaces, yourMoveChecksOf, yourMoveStepsOf } from "./your-move";
import { dayNow } from "./zones";

// The checks: everything waiting on his word, in one shape, with no limit: a guess of Life's his word would settle,
// shown with its evidence while something rides on it (Life uses its guess meanwhile), a decision an agent asks, or a
// new matter Life offers an agent for. Derived when read, never stored: his answer (`answerCheck`) goes to its kind's own
// store: a correction, a fact-check answer, the decision's answer, lifelog's naming queue, or the desk (a Start).

/** What a decision's card holds beyond every check's shape (`checks.ts`): its needs with their lines, how and whether Life saw it done, its plan's steps and what they were gathered from, its options with what each takes (and, on a plan card, its `role`: its id), its last send that did not go, the older card it replaces ("Replaces an older draft"). */
export const decisionCardOf = (d: Decision) => ({
  doneSeen: doneSeenShownOf(d.doneSeen, d.needs),
  doneSeenBy: doneSeenByOf(d),
  gathered: d.gathered ?? null,
  needs: needsShownOf(d.needs),
  notSent: notSentOf(d),
  options: d.options.map((o) => {
    const role = d.plan && planRoleOf(o.id);
    return { ...o, ...(role ? { role } : {}), takes: o.takes ?? null };
  }),
  plan: d.plan ?? null,
  replaces: d.replaces ?? null,
});

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
          goal: null,
          group: "decision",
          isPlan: d.plan !== undefined,
          kind: "decision",
          likelyPeople: [],
          links: d.links,
          ...sessionOf(d),
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
        matter: d.matter,
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
              text: link.quote,
              unit: later?.unit,
              where: later ? whereOf(later) : c.where.get(link.later),
            }
          ).map((r) => ({ ...r, basis: link.later }))
        : [];
    }),
  /** Each new matter offer (`newMatterOffersOf`). No deadline: it never outranks an agent's decision; on silence nothing starts and it leaves after its last day. */
  "new matter": (c) =>
    c.matters.flatMap((v) => {
      const [first] = v.steps;
      const { lastDay, next } = c.offered.get(v.id) ?? {};
      const firstLine = first && c.byId.get(first.ref);
      return first && lastDay && next && v.goal
        ? [
            {
              check: {
                ...NO_SAID,
                about: [],
                asker: LIFE_ASKER,
                at: null,
                clips: [],
                context: `${LIFE_CHECKS["new matter"].context} Next step: ${literalOf(next.text)}. Asked until ${plain(lastDay)}.`,
                deadline: null,
                draft: null,
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
              quote: {
                text: first.quote,
                unit: firstLine?.unit,
                where: plain(first.day),
              },
            },
          ]
        : [];
    }),
  /** The asks about who someone is: a guessed person, a Contacts card or a name Life cannot place, a same person, an at organization. */
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
            first ? { text: first.quote, unit: first.unit, where } : null
          )
        : [];
    });
    const byRef = keptBy(c, (l) =>
      [l.about ?? "", ...l.subjects].map((r) => people.refOf(r))
    );
    const cards = people.ambiguousCards.flatMap((a) => {
      // The people its name and handles say, named once: his answer is one of them.
      const handles =
        people.contacts.find((x) => x.id === a.card)?.handles ?? [];
      return ranked(
        c,
        "contacts card",
        {
          about: handles,
          likelyPeople: a.people.map(people.partyOf),
          ...cardAskOf(people.nameOf(a.card), handles),
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
          held
            ? { text: held.quote, unit: held.unit, where: whereOf(held) }
            : null
        );
      }
    );
    const same = samePersonAsksOf(people, c.samePersons).flatMap((a) =>
      ranked(c, "same person", a, a.linesOf(byRef), a.refs, null)
    );
    const at = atOrganizationAsksOf(people, c.atOrganizations).flatMap((a) =>
      ranked(c, "at organization", a, a.linesOf(byRef), a.refs, null)
    );
    return [...guessed, ...cards, ...same, ...at, ...named];
  },
  voice: (c) => voiceChecksOf(c.people, c.voices),
  "your move": (c) => yourMoveChecksOf(c, c.offered),
};

/** A decision's session (`Check.session`): a desk agent's card, its holder's now, or none; any other ask, its first link. */
const sessionOf = (d: Decision & { session?: string }) => {
  const session = d.agent ? d.session : d.links[0];
  return session ? { session } : {};
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
      .map(({ basis, check, day, matter: pick, quote, matterRank }) => {
        const context = withQuoteOf(
          check.context,
          (id) => inputs.where.has(id),
          quote
        );
        const card = {
          ...check,
          context,
          lifeLinks: lifeLinksOf(context, (id) => byId.has(id)),
          matter:
            cardMatterOf(matterOf([check.subject ?? check.ref], pick)) ?? null,
          onMatters: check.ridesOn.matterIds.flatMap(
            (id) => cardMatterOf(byId.get(id)) ?? []
          ),
          options: check.options.map((o) => {
            const icon = answerIconOf(o);
            return icon ? { ...o, icon } : o;
          }),
        };
        return {
          ...withComplaintFields(card, inputs.fixing, basis, quote?.text),
          day,
          matterRank,
        };
      })
  ).map(({ day: _, matterRank: __, ...check }) => check);
  return withDraftConfirms(found, c.people);
};

/** Checks in the order they were asked, the newest last (a matter's thread stacks them so); Life's own guesses, never asked (`at` null), after. */
export const byAsked = (a: Pick<Check, "at">, b: Pick<Check, "at">) =>
  Number(a.at === null) - Number(b.at === null) ||
  (a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : 0);

/** The checks about matter `id`: every kind, open matters they ride on and the one holding their subject (an ending is about a matter that reads probably done). */
export const checksOnMatterOf = <C extends Pick<Check, "matter" | "ridesOn">>(
  list: readonly C[],
  id: string
) =>
  list.filter((c) => c.matter?.id === id || c.ridesOn.matterIds.includes(id));

/** A check as the inbox lists it: with its `pushId` and its `urgency`. */
export type InboxCheck = Check & { pushId: string; urgency: Urgency };

/** The last list `checksNow` read, and what it was read from (`checksKeyOf`). */
let last: { key: string; list: Promise<InboxCheck[]> } | undefined;

/** Every file the checks read as stored (truth/ included; the project situations: a project head's answer is kept under this key), never units or their publications: the watcher's syncs write those every few minutes, and the checks don't read them but for an inferred person's evidence; the pictures' index. */
const CHECKS_READ = [
  ...MATTER_BOOK_READS,
  APPOINTMENTS,
  CLOSENESS,
  DECISIONS,
  PAGES,
  PERSON_PICTURES_INDEX,
  PROJECT_SITUATIONS,
  ZONES,
];

/** What the checks are read from, cheaply: the files they read (`readChangeStamp`: stats, no read), his day, the open decisions (one lapses), the stamp of what agents hold and the voices lifelog queues. The same key, the same list. */
const checksKeyOf = (
  held: HeldRead | null,
  voices: CheckInputs["voices"],
  decisions: readonly Decision[],
  holders: CardHolders
) =>
  JSON.stringify([
    // His Contacts, which the at organization cards read (`readAtOrganizationPairs`).
    readChangeStamp([...CHECKS_READ, ...readContactStores()]),
    dayNow(),
    decisions.map((d) => d.id),
    held && [held.stamp, holders],
    voices,
  ]);

/** What waits on his word now, over what is stored today and `held` (`CheckInputs`; host's `openChecksNow` reads it from the desk), and its `key` (`checksKeyOf`): read-only, no model call. Read again only when the key changed, and always while a run holds the lock, then under a key never given twice (its list may change under the same files' stamp): every reader of the inbox shares one read per change, and never mutates the list. */
export async function checksAndKeyNow(held: HeldRead | null) {
  const queue = await readNamingQueue();
  // Guesses that cannot be read leave the cards as lifelog suggests; the answer reads them again and refuses then.
  const voices = await withVoiceGuesses(queue).catch((e) => {
    log("run.error", { ...errorOf(e), step: "voice.guesses" });
    return queue;
  });
  const all = decisionsNow();
  // Each open card as its holder's, read from this one list (`HeldRead.cardHolders`).
  const decisions = all.filter((d) => d.state === "open");
  const holders = held?.cardHolders?.(decisions) ?? {};
  const key = checksKeyOf(held, voices, decisions, holders);
  if (isLocked() || last?.key !== key) {
    const list = readChecks(
      held,
      voices,
      decisions.map((d) => ({ ...d, ...holders[d.id] })),
      all
    );
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
  voices: CheckInputs["voices"],
  decisions: CheckInputs["decisions"],
  all: Decision[]
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
  const { nameContexts, titles, where } = await readSentences({
    lines,
    names: nameGroups,
    people,
    steps: new Set([...steps, ...yourMoveStepsOf(matters, today)]),
  });
  const key = secretIn("pushIdKey");
  const checks = checksOf({
    answered,
    atOrganizations: readAtOrganizationPairs(people),
    decisions,
    dismissed: readDismissedMatterPins(),
    doubted,
    endings: records.linkEndings,
    fixing: fixingOf(held?.complaints?.(all) ?? []),
    heldByAgents: held?.read() ?? null,
    isDirectionDue: directionDueOf(matters, records, dayNow()),
    isForHandOut: (id) => forHandOut.has(id),
    isParked: (id) => parked.has(id),
    // Kept: shown, not retired, at or above KEEP_AT (what `observationStatusOf` calls active).
    kept,
    lines,
    matterRank: new Map(
      rankedMattersOf(
        matters.filter(isAwaitingHisWord),
        people.nameOf,
        today,
        rankContextOf(people)
      ).map((v, i) => [v.id, i])
    ),
    matters,
    nameContexts,
    nameGroups,
    notNow: records.notNow,
    paged,
    people,
    places: readPlaces(),
    samePersons: samePersonPairsOf(people),
    titles,
    today,
    voices,
    where: new Map([
      ...where,
      ...records.episodes.map((m): [string, Where] => [
        m.id,
        `an episode, ${plain(m.day)}`,
      ]),
    ]),
  });
  return inboxChecksOf(await withNetworkIdentities(checks, people), key);
}

/** The inbox's cards as finally shown (their network identities attached): with their push ids and urgency. */
export const inboxChecksOf = (identified: readonly Check[], key: string) =>
  identified.map((c) => ({
    ...c,
    contactsCard: c.contactsCard ?? null,
    pushId: pushIdOf(c.ref, key),
    urgency: urgencyOf(c),
  }));
