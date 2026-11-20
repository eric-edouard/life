import { SUBJECT_PREFIX } from "../records/fields";
import { askPageOf, isAskPage } from "./card-request";
import { parseReadPartRef } from "./read-part";
import { asData, fetchOf } from "./words";

/**
 * `fetch`'s one entry: an ask page (`ask/<name>`, how to ask a card's part), a read part ref (anything that starts with a
 * subject prefix) opens that part, a malformed one says why, and any other id is a conversation, unit or turn
 * (`fetchOf`). `fromTurn` and `limit` mean nothing for a page or a part.
 */
export function openById(
  id: string,
  from: number | undefined,
  limit: number | undefined,
  readPerson: (
    name: string,
    o: { before?: string; byId: true; part: string; span?: string }
  ) => Promise<string | Record<string, unknown>>
): Promise<string | Record<string, unknown>> {
  if (isAskPage(id)) {
    return Promise.resolve(asData([askPageOf(id)]));
  }
  if (!SUBJECT_PREFIX.test(id)) {
    return fetchOf(id, from, limit);
  }
  const read = parseReadPartRef(id);
  if ("error" in read) {
    return Promise.resolve(asData([`(${read.error})`]));
  }
  if (from !== undefined || limit !== undefined) {
    return Promise.resolve(
      asData([
        "(a read part takes no fromTurn and no limit: it is one bounded piece; its next reads are at its end)",
      ])
    );
  }
  const { subject, ...o } = read.ref;
  return subject.startsWith("person:")
    ? readPerson(subject.slice("person:".length), { ...o, byId: true })
    : Promise.resolve(
        asData([`(no read parts for ${subject} yet: only a person's)`])
      );
}
