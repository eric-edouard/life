import { LIVE, nameOf, type Store } from "./lifelog";

// The live conversations Life lists by who spoke or when, each with what its label needs (`conversationLabel`).

/**
 * The live conversations (`c`) matching `rest` (a `where` tail and `order by`), each with the names of the people other
 * than the owner who spoke in it, as the directory names them (`byId`, `lifelogNames`) else as lifelog does.
 */
function conversationRows(
  store: Store,
  byId: Map<string, string>,
  rest: string,
  ...args: (string | number)[]
) {
  return store.db
    .query<
      { id: string; people: string; start_at: string },
      (string | number)[]
    >(
      `select c.id, c.start_at, (select json_group_array(distinct json_object('id', person_id, 'name', person_name))
        from turns where conversation_id = c.id and is_owner = 0 and (person_id is not null or person_name is not null))
        as people from conversations c where ${LIVE} and ${rest}`
    )
    .all(...args)
    .map((r) => ({
      id: r.id,
      names: (
        JSON.parse(r.people) as { id: string | null; name: string | null }[]
      ).flatMap((p) => nameOf(p.id, p.name, byId) ?? []),
      start_at: r.start_at,
    }));
}

/** The live conversations where lifelog's person (or one of the people) `personIds` spoke, newest first. */
export const conversationsWith = (
  store: Store,
  personIds: string[],
  byId: Map<string, string>
) =>
  conversationRows(
    store,
    byId,
    `c.id in (select conversation_id from turns where person_id in (select value from json_each(?)))
      order by c.start_at desc`,
    JSON.stringify(personIds)
  );

/** The live conversations that overlap [from, to), with who spoke. */
export const conversationsBetween = (
  store: Store,
  from: string,
  to: string,
  byId: Map<string, string>
) =>
  conversationRows(
    store,
    byId,
    "c.start_at < ?1 and c.end_at > ?2 order by c.start_at",
    to,
    from
  );
