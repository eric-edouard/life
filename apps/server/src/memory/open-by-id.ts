import { SUBJECT_PREFIX } from "../records/fields";
import { parseReadPartRef } from "./read-part";
import { person } from "./read-person-page";
import { asData, fetchOf } from "./words";

/**
 * `fetch`'s one entry: a read part ref (anything that starts with a subject prefix) opens that part, a malformed one
 * says why, and any other id is a conversation, unit or turn (`fetchOf`). `fromTurn` and `limit` mean nothing for a part.
 */
export function openById(
  id: string,
  from?: number,
  limit?: number
): Promise<string> {
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
    ? person(subject.slice("person:".length), { ...o, byId: true })
    : Promise.resolve(
        asData([`(no read parts for ${subject} yet: only a person's)`])
      );
}
