import { redact } from "../core/redact";
import { findRef, type Hit, readsOnce } from "./find-refs";
import { OWNER } from "./read-truth";
import { parseRef } from "./refs";
import { asData, fetchOf } from "./words";

/**
 * `fetch`'s one entry, over the one ref grammar (`parseRef`): a malformed ref says why; a person's read part opens by
 * its reader (someone only heard has evidence and no part); any other ref is looked for first (`findRef`), a miss says
 * why, and a hit is shown: an ask page (how to ask a card's part), a matter, an observation, a message or a file's
 * reading; a conversation, unit or turn is `fetchOf`'s. `fromTurn` and `limit` page a conversation only.
 */
export async function openById(
  id: string,
  from: number | undefined,
  limit: number | undefined,
  readPerson: (
    name: string,
    o: { before?: string; byId: true; part: string; span?: string }
  ) => Promise<string | Record<string, unknown>>,
  reads = readsOnce()
): Promise<string | Record<string, unknown>> {
  const ref = parseRef(id);
  if ("error" in ref) {
    return asData([`(${ref.error})`]);
  }
  if (ref.kind === "person" && (from !== undefined || limit !== undefined)) {
    return asData([
      "(a read part takes no fromTurn and no limit: it is one bounded piece; its next reads are at its end)",
    ]);
  }
  if (ref.kind === "person" && ref.read.subject.startsWith("person:")) {
    const { subject, ...o } = ref.read;
    return readPerson(subject.slice("person:".length), { ...o, byId: true });
  }
  // A conversation, unit or turn is looked up and shown by its own reader (`fetchOf`, over `findUnit` and `findTurn`).
  if (
    ref.kind === "conversation" ||
    ref.kind === "unit" ||
    ref.kind === "turn"
  ) {
    return fetchOf(id, from, limit);
  }
  const found = await findRef(ref, reads);
  if (!found.found) {
    return asData([`(${found.why})`]);
  }
  return shownOf(found, () => fetchOf(id, from, limit));
}

/** A hit as `fetch` shows it: a person's, a conversation's, a unit's or a turn's opened before, by its reader. */
function shownOf(
  hit: Hit,
  open: () => Promise<string | Record<string, unknown>>
) {
  switch (hit.kind) {
    case "appointment":
      return hit.appointment;
    case "ask":
      return asData([hit.page]);
    case "matter": {
      const { matter } = hit;
      return asData([
        `Matter "${matter.name}" (${matter.id}): ${matter.status}`,
        ...(matter.goal ? [`Goal: ${matter.goal.text}`] : []),
        ...(matter.nextStep ? [`Next step: ${matter.nextStep.text}`] : []),
        ...matter.steps.map((s) => `- ${s.day} ${s.text} (${s.ref})`),
      ]);
    }
    case "observation":
      return asData([
        `${hit.observation.date}: ${hit.observation.text} (${hit.observation.id})`,
        `(its evidence: read_observation ${hit.observation.id})`,
      ]);
    case "message":
      // Redacted as every reader of a chat shows it.
      return asData([
        `Message ${hit.event.id} in ${hit.event.chatName ?? hit.event.chat}`,
        `${hit.event.at} ${hit.event.fromMe ? OWNER : hit.event.sender}: ${redact(hit.event.text)}`,
      ]);
    case "file":
      return asData([
        `File ${hit.file.ref}`,
        ...[hit.file.description, hit.file.text].flatMap((t) =>
          t === undefined ? [] : [redact(t)]
        ),
      ]);
    case "conversation":
    case "person":
    case "turn":
    case "unit":
      return open();
    default:
      return hit satisfies never;
  }
}
