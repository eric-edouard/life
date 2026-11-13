import {
  type Beyond,
  INFERRED_USE_AT,
  unfoldedOf,
} from "../records/observation";
import { isUnderway } from "../records/truth";
import type { Truth } from "./read-truth";

// The context every memory call of a run sends first: who the owner is, and the people and projects a reply may name.

/** Who the owner is and his areas: the start of the context every memory call of a run shares (so it is cached). */
export function meContext(truth: Truth) {
  return {
    areas: truth.areas.map((a) => ({ id: a.id, name: a.name })),
    me: truth.me.text,
  };
}

/**
 * The map as the episodes, extract and pages prompts name it: the people on his map (with those Life inferred) and his
 * projects, every ref a reply may use (`map`). A call's `<context>` (the same for every call of a run, so it is cached)
 * shows the owner, his areas, the people close to him now (`shown`, `contextPeopleBy`) and the projects underway; the
 * others a call involves come in its input (`involvedOf`), so the context stays small as the map grows.
 */
export function refContext(
  {
    beyond,
    canon,
    truth,
  }: {
    /** Everyone beyond truth/ (`readPeople`). */
    beyond: Beyond[];
    /** Who a person ref is now (`readPeople`). */
    canon: (ref: string) => string;
    truth: Truth;
  },
  close: ReadonlySet<string>,
  shown: ReadonlySet<string>
) {
  // `close`: close to him personally (`personallyClose`), so what is between them weighs more.
  const flag = (ref: string) => (close.has(ref) ? { close: true } : {});
  const underway = new Set(
    truth.projects.filter(isUnderway).map((p) => `project:${p.id}`)
  );
  const map = {
    people: [
      ...truth.people.map((p) => ({
        aliases: p.aliases,
        name: p.name,
        ref: `person:${p.id}`,
        relation: p.relation,
        ...flag(`person:${p.id}`),
      })),
      // One ref per person: an id folded into another is that one. A guess is used from INFERRED_USE_AT and says
      // it is one; who his Contacts name is a name he gave a number, no relation known.
      ...unfoldedOf(beyond, canon)
        .filter((p) => (p.confidence ?? 1) >= INFERRED_USE_AT)
        .map((p) => ({
          aliases: [] as string[],
          name: p.name,
          ref: `person:${p.id}`,
          relation:
            p.kind === "inferred" ? `${p.relation} (inferred)` : p.relation,
          ...flag(`person:${p.id}`),
        })),
    ],
    projects: truth.projects.map((p) => ({
      area: p.area,
      description: p.notes.split("\n\n")[0]?.replace(/\s+/g, " ").slice(0, 300),
      name: p.name,
      people: p.people.map((id) => truth.people.find((x) => x.id === id)?.name),
      ref: `project:${p.id}`,
      status: p.status,
    })),
  };
  return {
    context: {
      ...meContext(truth),
      people: map.people.filter((p) => shown.has(p.ref)),
      projects: map.projects.filter((p) => underway.has(p.ref)),
    },
    map,
  };
}

/** The map's entries a call involves (`refs`) that its context leaves out: its input's `involved`. */
export function involvedOf(
  { context, map }: ReturnType<typeof refContext>,
  refs: ReadonlySet<string>
) {
  const inContext = new Set(
    [...context.people, ...context.projects].map((x) => x.ref)
  );
  const pick = <T extends { ref: string }>(list: T[]) =>
    list.filter((x) => refs.has(x.ref) && !inContext.has(x.ref));
  return { people: pick(map.people), projects: pick(map.projects) };
}
