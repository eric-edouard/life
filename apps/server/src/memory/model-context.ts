import { hasAddOn } from "../core/add-ons";
import {
  INFERRED_USE_AT,
  type PersonOutsideDirectory,
  unfoldedOf,
} from "../records/observation";
import { isUnderway } from "../records/truth";
import { isMailAddress } from "../sources/gmail";
import type { Truth } from "./read-truth";
import { nameKey } from "./units";

const NOT_LETTERS = /[^\p{L}]/gu;
const MIN_LETTERS = 4;

// The context every memory call of a run sends first: who the owner is, and the people and projects a reply may name.

/** Who the owner is and his areas: the start of the context every memory call of a run shares (so it is cached). */
export function meContext(truth: Truth) {
  return {
    areas: truth.areas.map((a) => ({ id: a.id, name: a.name })),
    me: truth.me.text,
  };
}

/**
 * The directory as the episodes, extract and pages prompts name it: the people in his directory (with those Life inferred) and his
 * projects, every ref a reply may use (`map`). A call's `<context>` (the same for every call of a run, so it is cached)
 * shows the owner, his areas, the people close to him now (`shown`, `contextPeopleBy`) and the projects underway; the
 * others a call involves come in its input (`involvedOf`), so the context stays small as the directory grows.
 */
export function refContext(
  {
    outsideDirectory,
    canon,
    truth,
  }: {
    /** Everyone outside the directory (`readPeople`). */
    outsideDirectory: PersonOutsideDirectory[];
    /** Who a person ref is now (`readPeople`). */
    canon: (ref: string) => string;
    truth: Truth;
  },
  close: ReadonlySet<string>,
  shown: ReadonlySet<string>
) {
  // `close`: close to him personally (`personallyClose`), so what is between them weighs more; no one is flagged
  // while the `relationships` add-on is off, the one place the flag is gated (the prompts' parts say it is not sent).
  const kept = hasAddOn("relationships") ? close : new Set<string>();
  const flag = (ref: string) => (kept.has(ref) ? { close: true } : {});
  const underway = new Set(
    truth.projects.filter(isUnderway).map((p) => `project:${p.id}`)
  );
  const directory = {
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
      ...unfoldedOf(outsideDirectory, canon)
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
    /** Who is close to him personally as far as the calls may say: none while the `relationships` add-on is off. */
    close: kept,
    context: {
      ...meContext(truth),
      people: directory.people.filter((p) => shown.has(p.ref)),
      projects: directory.projects.filter((p) => underway.has(p.ref)),
    },
    directory,
  };
}

/**
 * The mail addresses of each person, those of the cards and guesses folded into them too, for the one call that matches
 * a formal name to a nickname (`emailsShown`, `emailNameOf`).
 */
export function emailsOf({
  canon,
  outsideDirectory,
  truth,
}: Pick<
  Parameters<typeof refContext>[0],
  "canon" | "outsideDirectory" | "truth"
>) {
  const emails = new Map<string, Set<string>>();
  const add = (ref: string, handles: string[]) => {
    const own = handles.filter(isMailAddress);
    if (own.length > 0) {
      emails.set(ref, new Set([...(emails.get(ref) ?? []), ...own]));
    }
  };
  for (const p of truth.people) {
    add(`person:${p.id}`, p.handles.email);
  }
  for (const p of outsideDirectory) {
    add(canon(`person:${p.id}`), p.namesAndHandles);
  }
  return new Map([...emails].map(([ref, set]) => [ref, [...set]]));
}

/**
 * A resolver for `namedIn` to fall back to: the person whose mail address spells the name a text writes (the letters of
 * the local part, digits and punctuation dropped, at least 4: "malisuwan123@…" and "Mali Suwan"). The model still
 * decides whether they are the same person.
 * ponytail: a generic local part (contact@, info@) can match a common word; add a stoplist if it brings noise.
 */
export function emailNameOf(emails: Map<string, string[]>) {
  const byLetters = new Map<string, string>();
  for (const [ref, addresses] of emails) {
    for (const a of addresses) {
      const letters = nameKey(a.split("@")[0] ?? "").replace(NOT_LETTERS, "");
      if (letters.length >= MIN_LETTERS && !byLetters.has(letters)) {
        byLetters.set(letters, ref);
      }
    }
  }
  return (name: string) =>
    byLetters.get(nameKey(name).replaceAll(" ", "")) ?? null;
}

/** People of a call's context or input with their addresses when they have any: shown by the episodes call alone. */
export const emailsShown = <T extends { ref: string }>(
  people: T[],
  emails: Map<string, string[]>
) =>
  people.map((p) => {
    const own = emails.get(p.ref) ?? [];
    return own.length > 0 ? { ...p, emails: own } : p;
  });

/** The directory's entries a call involves (`refs`) that its context leaves out: its input's `involved`. */
export function involvedOf(
  { context, directory }: ReturnType<typeof refContext>,
  refs: ReadonlySet<string>
) {
  const inContext = new Set(
    [...context.people, ...context.projects].map((x) => x.ref)
  );
  const pick = <T extends { ref: string }>(list: T[]) =>
    list.filter((x) => refs.has(x.ref) && !inContext.has(x.ref));
  return { people: pick(directory.people), projects: pick(directory.projects) };
}
