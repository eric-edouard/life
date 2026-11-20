import type { SourceName } from "../core/names";
import type { SourceEvent } from "../records/source";
import type { FileEntry, Unit } from "../records/unit";
import { readImportedConversation } from "../sources/assistants";
import { openStore, turnPlace, withStore } from "../sources/lifelog";
import { askPageOf, noAskPageOf } from "./card-request";
import { readMatterBook } from "./matters";
import { readFiles, readIndex, readUnit } from "./memory-files";
import { lifeRefsOf, parseRef, type Ref } from "./refs";
import { sourceOf } from "./sources";
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

/** What a hit holds, by kind (a person's and a conversation's nothing: their readers open them). */
export interface Hit {
  event?: SourceEvent;
  file?: FileEntry;
  matter?: Matter;
  observation?: { date: string; id: string; text: string };
  page?: string;
  place?: { conversation: string; offset: number };
  unit?: Unit;
}

const hit = (h: Hit): Found<Hit> => ({ found: true, ...h });
const miss = (why: string): Found<Hit> => ({ found: false, why });

/** Whether `ref` names something that exists, by its kind's reader. */
export async function findRef(
  ref: Ref,
  reads: SharedReads,
  open = openStore
): Promise<Found<Hit>> {
  switch (ref.kind) {
    case "ask": {
      const page = askPageOf(ref.id);
      return page ? hit({ page }) : miss(noAskPageOf(ref.id));
    }
    case "person":
      return findPerson(ref.read.subject, reads);
    case "matter":
    case "observation":
      return findMatterOrObservation(ref.id, ref.kind, reads);
    case "unit": {
      const unit = await readUnit(ref.id);
      return unit ? hit({ unit }) : miss(`no unit ${ref.id}`);
    }
    case "message":
      return findMessage(ref.source, ref.message);
    case "file": {
      const file = readFiles().get(ref.file);
      return file ? hit({ file }) : miss(`no file ${ref.file}`);
    }
    case "turn": {
      const place = await withStore(
        (store) => turnPlace(store, ref.jobId, ref.turnIndex),
        open
      );
      return place
        ? hit({ place })
        : miss(`no turn ${ref.id}: lifelog no longer has it`);
    }
    case "conversation":
      return readImportedConversation(ref.id) ||
        (await withStore(
          (store) =>
            store.db
              .query("select 1 from turns where conversation_id = ? limit 1")
              .get(ref.id),
          open
        ))
        ? hit({})
        : miss(`no conversation ${ref.id}`);
    default:
      return ref satisfies never;
  }
}

/** A person's read part opens by the id `fetch` reads it by (`personFor`); a project's or an area's has none yet. */
async function findPerson(subject: string, reads: SharedReads) {
  if (!subject.startsWith("person:")) {
    return miss(`no read parts for ${subject} yet: only a person's`);
  }
  const id = subject.slice("person:".length);
  return personFor(id, meant(id, await reads.people()), true).known
    ? hit({})
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
    return matter ? hit({ matter }) : miss(`no matter ${id}`);
  }
  const observation = readIndex((db) =>
    db
      .query<{ date: string; id: string; text: string }, [string]>(
        "select id, date, text from observations where id = ?"
      )
      .get(id)
  );
  return observation ? hit({ observation }) : miss(`no observation ${id}`);
}

/** A message by its id, from its source's store whatever its age (`messageAt`), read as its reader gives it. */
function findMessage(source: SourceName, id: string) {
  const d = sourceOf(source);
  if (!(d.messageAt && (d.kind === "chat" || d.kind === "mail"))) {
    return miss(
      `Life can't open a ${d.label} message by its id: link its unit (unit_…) instead`
    );
  }
  try {
    const at = d.messageAt(id);
    const event =
      at &&
      d
        .read(new Date(at.first), new Date(Date.parse(at.last) + 1))
        .find((e) => e.id === id);
    return event ? hit({ event }) : miss(`no ${d.label} message ${id}`);
  } catch (error) {
    return miss(`${d.label} can't be read now: ${(error as Error).message}`);
  }
}

/** Why a card's context can't be shown: its first `life:` link that opens nothing; none when every one does. */
export async function deadLinkOf(context: string, reads: SharedReads) {
  const ids = lifeRefsOf(context);
  const found = await Promise.all(
    ids.map((id) => {
      const ref = parseRef(id);
      return "error" in ref ? miss(ref.error) : findRef(ref, reads);
    })
  );
  const i = found.findIndex((f) => !f.found);
  const dead = found[i];
  return dead && !dead.found
    ? `the link life:${ids[i]} opens nothing (${dead.why}): a \`life:\` link is a ref \`fetch\` opens`
    : undefined;
}
