import { findRef, readsOnce } from "./find-refs";
import { OWNER } from "./read-truth";
import { parseRef } from "./refs";
import { asData, fetchOf } from "./words";

/**
 * `fetch`'s one entry, over the one ref grammar (`parseRef`): a malformed ref says why; a person's read part opens by
 * its reader (someone only heard has evidence and no part); any other ref is looked for first (`findRef`), a miss says
 * why, and a hit is shown: an ask page (how to ask a card's part), a matter, an observation, a message, a file's reading,
 * or a conversation, unit or turn (`fetchOf`). `fromTurn` and `limit` page a conversation only.
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
  const found = await findRef(ref, reads);
  if (!found.found) {
    return asData([`(${found.why})`]);
  }
  const { event, file, matter, observation, page } = found;
  if (page) {
    return asData([page]);
  }
  if (matter) {
    return asData([
      `Matter "${matter.name}" (${matter.id}): ${matter.status}`,
      ...(matter.goal ? [`Goal: ${matter.goal.text}`] : []),
      ...(matter.nextStep ? [`Next step: ${matter.nextStep.text}`] : []),
      ...matter.steps.map((s) => `- ${s.day} ${s.text} (${s.ref})`),
    ]);
  }
  if (observation) {
    return asData([
      `${observation.date}: ${observation.text} (${observation.id})`,
      `(its evidence: read_observation ${observation.id})`,
    ]);
  }
  if (event) {
    return asData([
      `Message ${event.id} in ${event.chatName ?? event.chat}`,
      `${event.at} ${event.fromMe ? OWNER : event.sender}: ${event.text}`,
    ]);
  }
  if (file) {
    return asData([
      `File ${file.ref}`,
      ...[file.description, file.text].filter((t) => t !== undefined),
    ]);
  }
  return fetchOf(id, from, limit);
}
