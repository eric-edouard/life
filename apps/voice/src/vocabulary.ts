// The words the owner wants spelled right, and a block's keyterms: his vocabulary, then people's
// names and aliases. The feed carries the vocabulary whole on every page (feed.ts).

import type { Db } from "@lifelog/db";
import { people, vocabulary } from "@lifelog/db/schema";
import { notInArray } from "drizzle-orm";
import { z } from "zod";
import { logChange } from "./change-log";

// Provider limits: under 50 characters, at most 5 words, none of < > { } [ ] \.
const WHITESPACE = /\s+/;
export const Keyterm = z
  .string()
  .min(1)
  .max(49)
  .regex(/^[^<>{}[\]\\]+$/)
  .refine((s) => s.trim().split(WHITESPACE).length <= 5, "at most 5 words");
// More imposes a 20 s minimum billable duration per request.
const MAX_KEYTERMS = 100;

// A block's keyterms: the owner's vocabulary, then every person's name and aliases (by name), without
// repeats, as many as the provider takes. Not part of what makes a block "the same": its pages are.
export const blockKeyterms = (db: Db) => {
  const terms = vocabularyTerms(db);
  const named = db.select().from(people).orderBy(people.name).all();
  const all = [
    ...terms,
    ...named.flatMap((p) => [p.name, ...p.aliases]),
  ].filter((term) => Keyterm.safeParse(term).success);
  const seen = new Set<string>();
  return all
    .filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, MAX_KEYTERMS);
};

// The owner's vocabulary, in order.
export const vocabularyTerms = (db: Pick<Db, "select">) =>
  db
    .select()
    .from(vocabulary)
    .orderBy(vocabulary.term)
    .all()
    .map((v) => v.term);

// The owner's whole list replaces the stored one; the same list again changes nothing. A change
// wakes the feed, which carries the list.
export function setVocabulary(db: Db, terms: string[]) {
  const wanted = [...new Set(terms)];
  db.transaction((tx) => {
    const removed = tx
      .delete(vocabulary)
      .where(
        wanted.length > 0 ? notInArray(vocabulary.term, wanted) : undefined
      )
      .returning({ term: vocabulary.term })
      .all();
    const added =
      wanted.length > 0
        ? tx
            .insert(vocabulary)
            .values(wanted.map((term) => ({ term })))
            .onConflictDoNothing()
            .returning({ term: vocabulary.term })
            .all()
        : [];
    if (removed.length + added.length > 0) {
      logChange(tx, "vocabulary", "vocabulary");
    }
  });
  return vocabularyTerms(db);
}
