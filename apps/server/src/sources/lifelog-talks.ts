import { LIVE, type Store } from "./lifelog";

// The live conversations Life lists by who spoke or when, each with what its label needs (`conversationLabel`).

/**
 * The live conversations (`c`) matching `rest` (a `where` tail and `order by`), each with the sorted names lifelog gave
 * the people other than the owner who spoke in it: what the conversation label needs.
 */
function talks(store: Store, rest: string, ...args: (string | number)[]) {
  return store.db
    .query<
      { id: string; names: string; start_at: string },
      (string | number)[]
    >(
      `select c.id, c.start_at, (select json_group_array(distinct person_name) from turns
        where conversation_id = c.id and is_owner = 0 and person_name is not null) as names
        from conversations c where ${LIVE} and ${rest}`
    )
    .all(...args)
    .map((r) => ({ ...r, names: (JSON.parse(r.names) as string[]).sort() }));
}

/** The live conversations where lifelog's person (or one of the people) `personIds` spoke, newest first. */
export const conversationsWith = (store: Store, personIds: string[]) =>
  talks(
    store,
    `c.id in (select conversation_id from turns where person_id in (select value from json_each(?)))
      order by c.start_at desc`,
    JSON.stringify(personIds)
  );

/** The live conversations that overlap [from, to), with who spoke. */
export const conversationsBetween = (store: Store, from: string, to: string) =>
  talks(
    store,
    "c.start_at < ?1 and c.end_at > ?2 order by c.start_at",
    to,
    from
  );
