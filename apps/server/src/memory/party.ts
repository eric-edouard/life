import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MACHINE_DIR } from "../core/platform";
import type { DirectoryParty } from "../records/truth";

// A party (docs/glossary.md): anyone Life has a ref for, a person or an organization, as every app is shown them. Built
// here only (`partyOf`), from who they are (`readPeople`) and the pictures they show (`person-pictures.ts`).

export const PERSON_PICTURES = join(MACHINE_DIR, "person-pictures");
export const PERSON_PICTURES_INDEX = join(MACHINE_DIR, "person-pictures.json");
/** A kept picture's file in `PERSON_PICTURES`, by its id. */
export const pictureFileOf = (id: string) => `${id}.jpg`;

/** Each person's pictures, by their ref as placed when kept: Contacts' first, then each source's. */
const PictureIndex = z.object({
  people: z.record(
    z.string(),
    z.array(z.object({ id: z.string(), source: z.string() }))
  ),
});
export type PictureIndex = z.infer<typeof PictureIndex>["people"];

/** The pictures each person shows, as last kept; none before the first keeping, or while an older index's shape stands (rebuilt within the hour). */
export function readPictureIndex(): PictureIndex {
  try {
    return (
      PictureIndex.safeParse(
        JSON.parse(readFileSync(PERSON_PICTURES_INDEX, "utf8"))
      ).data?.people ?? {}
    );
  } catch {
    return {};
  }
}

/** Someone Life has a ref for, as an app shows them: `line` is what they are to him (`relationOf`), `picture` the one they show (his pick, else their first). */
export interface Party {
  kind: "organization" | "person";
  line?: string;
  name: string;
  picture?: { id: string };
  ref: string;
}

/**
 * The one way a ref becomes a party: who it is today (`refOf`), its name, whether it is an organization, its line, and
 * the picture his pick in his directory names (`pictureFrom`; `none`: no picture; a source no longer showing one: the
 * first). `pictures` is read once, on the first party asked.
 */
export function partyOf(
  // Typed here, not as `People`'s: `readPeople` holds the party function this returns.
  people: {
    isOrganization: (ref: string) => boolean;
    nameOf: (ref: string) => string;
    refOf: (ref: string) => string;
    relationOf: (ref: string) => string | null;
  },
  directory: readonly Pick<DirectoryParty, "id" | "pictureFrom">[],
  pictures: () => PictureIndex
) {
  const picks = new Map(
    directory.map((p) => [`person:${p.id}`, p.pictureFrom])
  );
  let index: PictureIndex | undefined;
  return (ref: string): Party => {
    const now = people.refOf(ref);
    const pick = picks.get(now);
    index ??= pictures();
    const shown = index[now] ?? [];
    const picture =
      pick === "none"
        ? undefined
        : (shown.find((p) => p.source === pick) ?? shown[0]);
    const line = people.relationOf(now);
    return {
      kind: people.isOrganization(now) ? "organization" : "person",
      ...(line ? { line } : {}),
      name: people.nameOf(now),
      ...(picture ? { picture: { id: picture.id } } : {}),
      ref: now,
    };
  };
}
