import { SECOND } from "../core/clock";
import type { Correction } from "../records/observation";
import type { SourceEvent } from "../records/source";
import type { FileEntry, Unit } from "../records/unit";
import { readImportedConversation } from "../sources/assistants";
import type { Descriptor } from "../sources/contract";
import { openStore, turnPlace, withStore } from "../sources/voice-server";
import { askPageOf, noAskPageOf } from "./card-request";
import { matterOfSteps } from "./matter-read";
import { readMatterBook } from "./matters";
import { readIndex, readUnit } from "./memory-files";
import { readFiles } from "./message-files";
import { type Need, needRefsOf } from "./needs";
import {
  type AppointmentSheet,
  readAppointmentSheet,
} from "./read-appointments";
import { partErrorOf, type ReadPartRef } from "./read-part";
import { lifeRefsOf, parseRef, type Ref } from "./refs";
import { deletedReadOf, enabledSources } from "./sources";
import { isLifeOutput } from "./units";
import { meant, type People, personFor, readPeople } from "./who";
import { dayNow } from "./zones";

// Whether a ref `fetch` takes (`refs.ts`) names something that exists, each kind by its own reader: a hit with what was
// found, or a miss with why. Only `openById` renders a hit; a card's `life:` links must all hit (`requestDecision`).

export type Found<T> = ({ found: true } & T) | { found: false; why: string };
type Matter = Awaited<ReturnType<typeof readMatterBook>>[number];

/** What a request reads once and shares between its lookups: the people, and the matter book. */
export interface SharedReads {
  book: () => Promise<Matter[]>;
  people: () => Promise<People>;
}
export function readsOnce(): SharedReads {
  let people: Promise<People> | undefined;
  let book: Promise<Matter[]> | undefined;
  const readPeopleOnce = () => {
    people ??= readPeople();
    return people;
  };
  return {
    book: () => {
      book ??= readPeopleOnce().then((p) => readMatterBook(p, dayNow()));
      return book;
    },
    people: readPeopleOnce,
  };
}

/** What a hit holds, by its kind (a person's and a conversation's nothing: their readers open them). */
export type Hit =
  | { appointment: AppointmentSheet; kind: "appointment" }
  | { kind: "ask"; page: string }
  | { kind: "conversation" }
  | { event: SourceEvent; kind: "message" }
  | { file: FileEntry; kind: "file" }
  | { kind: "matter"; matter: Matter }
  | {
      kind: "observation";
      observation: { date: string; id: string; text: string };
    }
  | { kind: "person" }
  | { kind: "turn"; place: { conversation: string; offset: number } }
  | { kind: "unit"; unit: Unit };

const hit = <T extends Hit>(h: T): Found<T> => ({ found: true, ...h });
const miss = (why: string): { found: false; why: string } => ({
  found: false,
  why,
});

/** A unit by its id. */
export async function findUnit(id: string) {
  const unit = await readUnit(id);
  return unit ? hit({ kind: "unit", unit }) : miss(`no unit ${id}`);
}

/** A turn of the voice server's store, where it is in its conversation. */
export async function findTurn(
  id: string,
  t: { jobId: string; turnIndex: number },
  open = openStore
) {
  const place = await withStore(
    (store) => turnPlace(store, t.jobId, t.turnIndex),
    open
  );
  return place
    ? hit({ kind: "turn", place })
    : miss(`no turn ${id}: lifelog no longer has it`);
}

/** Whether `ref` names something that exists, by its kind's reader. */
export async function findRef(
  ref: Ref,
  reads: SharedReads,
  open = openStore
): Promise<Found<Hit>> {
  switch (ref.kind) {
    case "ask": {
      const page = askPageOf(ref.id);
      return page ? hit({ kind: "ask", page }) : miss(noAskPageOf(ref.id));
    }
    case "person":
      return findPerson(ref.read, reads);
    case "matter":
    case "observation":
      return ref.kind === "matter" && ref.thread
        ? findThread(ref.thread.matter, reads)
        : findMatterOrObservation(ref.id, ref.kind, reads);
    case "unit":
      return findUnit(ref.id);
    case "message":
      return findMessage(ref);
    case "appointment": {
      const appointment = await openAppointment({ appointment: ref.id }, reads);
      return appointment
        ? hit({ appointment, kind: "appointment" })
        : miss(`no appointment ${ref.id}`);
    }
    case "card":
      return miss(`a card (${ref.id}) is his to answer in Life, not to fetch`);
    case "episode":
      return miss(`an episode (${ref.id}) is read through its day's units`);
    case "file": {
      const file = readFiles().get(ref.file);
      return file ? hit({ file, kind: "file" }) : miss(`no file ${ref.file}`);
    }
    case "turn":
      return findTurn(ref.id, ref, open);
    case "conversation":
      return readImportedConversation(ref.id) ||
        (await withStore(
          (store) =>
            store.db
              .query("select 1 from turns where conversation_id = ? limit 1")
              .get(ref.id),
          open
        ))
        ? hit({ kind: "conversation" })
        : miss(`no conversation ${ref.id}`);
    default:
      return ref satisfies never;
  }
}

/** A matter's thread, by its matter's id or a step's (`matterOfSteps`, as `read_matter` finds it). */
async function findThread(id: string, reads: SharedReads) {
  const matter = matterOfSteps(await reads.book(), [id]);
  return matter ? hit({ kind: "matter", matter }) : miss(`no matter ${id}`);
}

/** A message by its ref: only from a source he turned on, one with a reader of chat or mail. */
export function findMessage(ref: { message: string; source: string }) {
  const d = enabledSources().find((x) => x.name === ref.source);
  return d && (d.kind === "chat" || d.kind === "mail")
    ? findMessageIn(d, ref.message)
    : miss(`${ref.source} is off or holds no messages`);
}

/** An appointment as its event sheet shows it (`read_appointments`, `fetch`), its message opened by `findMessage`. */
export const openAppointment = (
  q: { appointment?: string; pushId?: string },
  reads: SharedReads
) =>
  readAppointmentSheet(q, {
    ...reads,
    message: (key) => {
      const ref = parseRef(`msg:${key}`);
      const found =
        "error" in ref || ref.kind !== "message" ? null : findMessage(ref);
      return found?.found ? found.event : null;
    },
  });

/** The parts a link may name: always there (an add-on's go with it, a conversation summary is his alone). */
const LINKED_PARTS = ["now", "page", "evidence", "latest"];

/** A person's read part as `fetch` reads it by id (`personFor`), of a part always there; a project's or an area's has none yet. */
async function findPerson(read: ReadPartRef, reads: SharedReads) {
  const { subject } = read;
  if (!subject.startsWith("person:")) {
    return miss(`no read parts for ${subject} yet: only a person's`);
  }
  const bad = partErrorOf(read, LINKED_PARTS);
  if (bad) {
    return miss(bad);
  }
  const id = subject.slice("person:".length);
  return personFor(id, meant(id, await reads.people()), true).known
    ? hit({ kind: "person" })
    : miss(`no one is ${subject}`);
}

/** A matter from the book; an observation by its index row, or as its matter when a lone one's matter has its id. */
async function findMatterOrObservation(
  id: string,
  kind: "matter" | "observation",
  reads: SharedReads
) {
  const matter = (await reads.book()).find((m) => m.id === id);
  if (matter || kind === "matter") {
    return matter ? hit({ kind: "matter", matter }) : miss(`no matter ${id}`);
  }
  const observation = readIndex((db) =>
    db
      .query<{ date: string; id: string; text: string }, [string]>(
        "select id, date, text from observations where id = ?"
      )
      .get(id)
  );
  return observation
    ? hit({ kind: "observation", observation })
    : miss(`no observation ${id}`);
}

/** A message by its id, from its source's store whatever its age (`messageAt`), as its reader gives it; never Life's own. */
export function findMessageIn(
  d: Pick<Descriptor, "kind" | "label" | "messageAt"> &
    Partial<{
      name: string;
      read: (since: Date, before?: Date) => SourceEvent[];
    }>,
  id: string
) {
  if (!(d.messageAt && d.read)) {
    return miss(
      `Life can't open a ${d.label} message by its id: link its unit (unit_…) instead`
    );
  }
  try {
    const at = d.messageAt(id);
    // A second past its last version: a store may keep instants without milliseconds, compared as text.
    const event =
      at &&
      deletedReadOf(d.name ?? "", d.read)(
        new Date(at.first),
        new Date(Date.parse(at.last) + SECOND)
      ).find((e) => e.id === id && !isLifeOutput(e));
    return event
      ? hit({ event, kind: "message" })
      : miss(`no ${d.label} message ${id}`);
  } catch (error) {
    return miss(`${d.label} can't be read now: ${(error as Error).message}`);
  }
}

/** Why a card's context can't be shown: blank, or its first `life:` link that opens nothing; none when it can. */
export function contextProblemOf(context: string, reads: SharedReads) {
  if (context.trim() === "") {
    return Promise.resolve(
      "`context` is required, in Markdown: why you ask, why you drafted this, what you tried, with links"
    );
  }
  return refsProblemOf(
    lifeRefsOf(context),
    reads,
    (id) => `the link life:${id}`,
    "a `life:` link"
  );
}

/** Why a card can't be asked for its refs: its `context`'s (`contextProblemOf`), then its needs' (a QR's message); none when all open. */
export async function cardRefsProblemOf(
  ask: { context: string; needs?: Need[] },
  reads: SharedReads
) {
  return (
    (await contextProblemOf(ask.context, reads)) ??
    refsProblemOf(
      needRefsOf(ask.needs),
      reads,
      (ref) => `the qr need's \`ref\` ${ref}`,
      "a QR's `ref`"
    )
  );
}

/** Why one of `ids` can't be opened: the first that opens nothing, named by `named`; none when all open. */
export async function refsProblemOf(
  ids: readonly string[],
  reads: SharedReads,
  named: (id: string) => string,
  what: string
) {
  for (const id of ids) {
    const ref = parseRef(id);
    // biome-ignore lint/performance/noAwaitInLoops: stops at the first dead ref
    const found = "error" in ref ? miss(ref.error) : await findRef(ref, reads);
    if (!found.found) {
      return `${named(id)} opens nothing (${found.why}): ${what} is a ref \`fetch\` opens`;
    }
  }
}

/** Why his correction's next step can't be shown: its `context` (a `matter-direction`'s), by a card's rule; none when it has none or can. */
export function nextStepContextProblemOf(c: Correction, reads: SharedReads) {
  const context =
    c.kind === "matter-direction" ? c.nextStep?.context : undefined;
  return context === undefined ? undefined : contextProblemOf(context, reads);
}
