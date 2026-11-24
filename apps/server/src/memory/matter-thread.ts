import { newestDays } from "../core/lists";
import { redact } from "../core/redact";
import type { Appointment } from "../records/appointment";
import type { Episode } from "../records/episode";
import type { Observation } from "../records/observation";
import { eventKey, type SourceEvent } from "../records/source";
import { readAppointments } from "./appointments";
import { findMessage } from "./find-refs";
import { episodeAt, type MatterStepNow, matterOfSteps } from "./matter-read";
import { readMatterBookAndRecords } from "./matters";
import { readFiles, showFiles } from "./message-files";
import type { Party } from "./party";
import { paymentWordsOf, placedOn } from "./payments";
import { chatOpenUrlOf, kindOf, sourceOf } from "./sources";
import { callSpanOf, speakerOf, textOf } from "./units";
import { type People, readPeople } from "./who";
import { asData } from "./words";
import { dayNow } from "./zones";

// A matter's thread (`<matter id>/thread`, a read part `fetch` opens, as data): its steps as the lines they cite, in
// time order, a page of whole days at a time. A message belongs to a matter only when one of its facts cites it
// (`Observation.source`): a chat-day's other lines are not the matter's. Read when asked, never stored.

/** One line of a thread: when (`at`, `day`), what (`kind`, `text`), who (`speaker`), where (`channel`), and what opens it: `ref` for `fetch`, `open` the source's app, `facts` the observations citing it; a moment, a to-do item and Life's step carry their matter step's id (`step`), which `fetch` does not open yet. */
export type ThreadLine = {
  at: string;
  day: string;
  text: string;
} & (
  | {
      channel: string;
      facts: string[];
      kind: "call" | "message" | "quote" | "voice";
      open?: string;
      ref: string;
      speaker: Party;
      span?: { at: string; until: string };
    }
  | { kind: "event"; ref: string; start: string }
  | { kind: "life" | "moment" | "todo_item"; step: string }
  | {
      amount: number;
      category: string | null;
      currency: string;
      episode: string;
      kind: "payment";
      payment: string;
    }
);

type Cites = Pick<Observation, "at" | "date" | "quote" | "source" | "speaker">;

/** A line before it is read: a step, or the line a step's facts cite (`facts`), or an appointment read from its facts. */
type Planned = { at: string; day: string } & (
  | { cites: Cites; facts: string[]; kind: "cited" }
  | { episode: Episode; kind: "moment" }
  | { appointment: Pick<Appointment, "id" | "start" | "title">; kind: "event" }
  | { kind: "life" | "todo_item"; ref: string; text: string }
);

/** How many lines a page holds (whole days: the oldest day may add some); a moment's payments come with it. */
const THREAD_LINES = 30;
/** A message is cut here: the whole one is its `ref`'s. */
const LINE_CHARS = 1000;
/** In time order, whatever zone an instant was written in. */
const byAt = (a: { at: string }, b: { at: string }) =>
  Date.parse(a.at) - Date.parse(b.at);

/** A step that is no observation as its line: an episode as a moment, a to-do item, a ledger line as Life's step. */
function stepLineOf(
  s: MatterStepNow,
  episodeOf: (id: string) => Episode | undefined
): Planned[] {
  if (s.kind === "ledger" || s.kind === "todo_item") {
    const kind = s.kind === "ledger" ? "life" : "todo_item";
    return [{ at: s.at, day: s.day, kind, ref: s.ref, text: s.text }];
  }
  const episode = episodeOf(s.ref);
  return episode ? [{ at: s.at, day: s.day, episode, kind: "moment" }] : [];
}

/**
 * A matter's steps as the lines they stand for, in time order: an observation as the line it cites (facts citing one
 * line make one), an episode as a moment, a to-do item, a ledger line (Life's step), and an appointment read from its
 * facts, at the newest of them. Pure.
 */
export function threadPlanOf(
  steps: readonly MatterStepNow[],
  observationOf: (id: string) => Cites | undefined,
  episodeOf: (id: string) => Episode | undefined,
  appointments: readonly Pick<
    Appointment,
    "id" | "observations" | "start" | "title"
  >[]
): Planned[] {
  const isRecord = (s: MatterStepNow) =>
    ["episode", "ledger", "todo_item"].includes(s.kind);
  const facts = steps.flatMap((s) => {
    const o = isRecord(s) ? undefined : observationOf(s.ref);
    return o ? [{ o, ref: s.ref }] : [];
  });
  const cited = [
    ...Map.groupBy(facts, (f) => `${f.o.source.channel}|${f.o.source.ref}`),
  ].map(([, group]) => {
    // A group holds one fact at least.
    const { o } = group[0] as (typeof group)[number];
    return {
      at: o.at,
      cites: o,
      day: o.date,
      facts: group.map((f) => f.ref),
      kind: "cited" as const,
    };
  });
  const lineOfFact = new Map(
    cited.flatMap((c) => c.facts.map((f) => [f, c] as const))
  );
  const events = appointments.flatMap((a): Planned[] => {
    const newest = a.observations
      .flatMap((f) => lineOfFact.get(f) ?? [])
      .toSorted(byAt)
      .at(-1);
    return newest
      ? [{ appointment: a, at: newest.at, day: newest.day, kind: "event" }]
      : [];
  });
  return [
    ...cited,
    ...steps.flatMap((s) => (isRecord(s) ? stepLineOf(s, episodeOf) : [])),
    ...events,
  ].toSorted(byAt);
}

/** The cited line as its source shows it: the message (or call) its facts cite, opened by its id; a recording's turn, or a line Life cannot open now, as the facts quote it. */
function citedLineOf(
  p: Planned & { kind: "cited" },
  people: People
): ThreadLine {
  const { channel, ref } = p.cites.source;
  const base = { at: p.at, channel, day: p.day, facts: p.facts };
  const quoted = (kind: "quote" | "voice"): ThreadLine => ({
    ...base,
    kind,
    ref: kind === "voice" ? ref : (p.facts[0] as string),
    speaker: people.partyOf(p.cites.speaker),
    text: p.cites.quote,
  });
  if (kindOf(channel) === "voice") {
    return quoted("voice");
  }
  const found = findMessage({ message: ref, source: channel });
  if (!found.found || found.kind !== "message") {
    return quoted("quote");
  }
  return messageLineOf(found.event, base, people);
}

/** A message as a line: its words (its files as lines, a call as its call line and span), who wrote it, its `msg:` ref and the link into its app. */
function messageLineOf(
  e: SourceEvent,
  base: { at: string; channel: string; day: string; facts: string[] },
  people: People
): ThreadLine {
  const source = sourceOf(e.source);
  const open = chatOpenUrlOf(e.source, [
    source.handleOf?.(e.chat),
    // A sender's own chat only for a chat its source knows is of two: never a group's member.
    e.fromMe || source.group?.(e.chat) !== false ? undefined : e.sender,
  ]);
  const words = e.phoneCall
    ? textOf(e)
    : (showFiles([e], readFiles())[0]?.text ?? e.text);
  return {
    ...base,
    at: e.at,
    kind: e.phoneCall ? "call" : "message",
    ...(open ? { open } : {}),
    ref: `msg:${eventKey(e)}`,
    speaker: people.partyOf(speakerOf(e.source, e, people.resolve)),
    ...(e.phoneCall ? { span: callSpanOf(e) } : {}),
    text: redact(words).slice(0, LINE_CHARS),
  };
}

/** The payments of a page's moments, in one read over their days: each placed in its smallest episode (`placedOn`), kept when that is one of the moments; none while payments are off or unreadable. */
async function paymentLinesOf(
  moments: readonly Episode[],
  episodes: Episode[]
): Promise<ThreadLine[]> {
  const days = moments
    .flatMap((m) => [m.start ?? m.day, m.end ?? m.start ?? m.day])
    .map((d) => d.slice(0, 10))
    .toSorted();
  const [from] = days;
  const to = days.at(-1);
  if (!(from && to)) {
    return [];
  }
  const ids = new Set(moments.map((m) => m.id));
  const { list } = await placedOn(from, to, episodes, []);
  return list
    .filter((p) => p.episode && ids.has(p.episode.id))
    .map(({ day, episode, payment: p }) => ({
      amount: p.amount,
      at: p.paidAt ?? episodeAt(episode as Episode),
      category: paymentWordsOf(p).category,
      currency: p.currency,
      day,
      episode: (episode as Episode).id,
      kind: "payment",
      payment: p.id,
      text: paymentWordsOf(p).merchant,
    }));
}

/** A planned line as the thread shows it; a cited one opened from its source. */
function lineOf(p: Planned, people: People): ThreadLine {
  switch (p.kind) {
    case "cited":
      return citedLineOf(p, people);
    case "moment":
      return {
        at: p.at,
        day: p.day,
        kind: "moment",
        step: p.episode.id,
        text: p.episode.title,
      };
    case "event":
      return {
        at: p.at,
        day: p.day,
        kind: "event",
        ref: p.appointment.id,
        start: p.appointment.start,
        text: p.appointment.title,
      };
    default:
      return { at: p.at, day: p.day, kind: p.kind, step: p.ref, text: p.text };
  }
}

/**
 * A matter's thread, by its id or a step's (`matterOfSteps`): the newest `THREAD_LINES` lines by whole days, `before`
 * a day pages back (`nextBefore` names the next page), in time order. Only the page's cited messages are opened, by
 * their ids, and only its moments' days' payments read: never a chat or a source whole. Its open asks are
 * `read_matter`'s `checks`.
 */
export async function readMatterThread(id: string, before?: string) {
  const people = await readPeople();
  const { book, records } = await readMatterBookAndRecords(people, dayNow());
  const matter = matterOfSteps(book, [id]);
  if (!matter) {
    return asData([`(no matter ${id})`]);
  }
  const observations = new Map(records.observations.map((o) => [o.id, o]));
  const episodes = new Map(records.episodes.map((e) => [e.id, e]));
  const plan = threadPlanOf(
    matter.steps,
    (f) => observations.get(f),
    (e) => episodes.get(e),
    readAppointments()?.appointments ?? []
  );
  const { next, taken } = newestDays(
    plan.toReversed(),
    (p) => p.day,
    THREAD_LINES,
    before
  );
  const page = taken.toReversed();
  const payments = await paymentLinesOf(
    page.flatMap((p) => (p.kind === "moment" ? [p.episode] : [])),
    records.episodes
  );
  return {
    matter: matter.id,
    ...(next ? { nextBefore: next } : {}),
    thread: [...page.map((p) => lineOf(p, people)), ...payments].toSorted(byAt),
  };
}
