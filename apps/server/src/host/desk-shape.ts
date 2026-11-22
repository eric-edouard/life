import type { Database } from "bun:sqlite";

// The desk store's shape: which of the desk helper's store steps (`desk/store-step.ts`) it still needs. Only those steps
// change it; `openDesk` and the readers refuse a store of an old shape.

/** Whether `table` of the store has `column`. */
export const hasColumn = (db: Database, table: string, column: string) =>
  db
    .query(`select 1 from pragma_table_info('${table}') where name = ?`)
    .get(column) !== null;

/** Whether the store predates assignments (`desk/store-step.ts`'s `stepStore` reshapes it). */
export const isBeforeAssignments = (db: Database) =>
  hasColumn(db, "agent", "wait_events");

/** Whether the store's agents predate roles (`stepRoles` reshapes it): a store that has agents and no `role`. */
export const isBeforeRoles = (db: Database) =>
  hasColumn(db, "agent", "id") && !hasColumn(db, "agent", "role");

/** Whether the store's agents still check their role against a list (`stepRoleCheck` rebuilds them without it). */
export const isBeforeRoleCheck = (db: Database) =>
  db
    .query(
      "select 1 from sqlite_master where type = 'table' and name = 'agent' and sql like '%check (role in%'"
    )
    .get() !== null;

/** Whether the store's assignments predate the matter he chose (`stepMatterIds` reshapes it): assignments and no `matter_id`. */
export const isBeforeMatterIds = (db: Database) =>
  hasColumn(db, "assignment", "id") &&
  !hasColumn(db, "assignment", "matter_id");

/** Whether the store's turns predate their model (`stepTurnModel` adds it): a store that has turns and no `turn.model`. */
export const isBeforeTurnModel = (db: Database) =>
  hasColumn(db, "turn", "id") && !hasColumn(db, "turn", "model");

/** Whether the store's turns predate their searches' cost (`stepTurnSearchCost` adds it): turns and no `turn.search_usd`. */
export const isBeforeTurnSearchCost = (db: Database) =>
  hasColumn(db, "turn", "id") && !hasColumn(db, "turn", "search_usd");

/** Whether the store's agents predate moves (`stepMoves` reshapes it, decision 78): agents, and no `move` table or no `turn.move`. */
export const isBeforeMoves = (db: Database) =>
  hasColumn(db, "agent", "id") &&
  !(
    db
      .query(
        "select 1 from sqlite_master where type = 'table' and name = 'move'"
      )
      .get() && hasColumn(db, "turn", "move")
  );

/** Whether the store at `db` is of an old shape: only the desk helper's store steps (`desk/store-step.ts`) change it. */
export const isOldShape = (db: Database) =>
  isBeforeAssignments(db) ||
  isBeforeRoles(db) ||
  isBeforeRoleCheck(db) ||
  isBeforeTurnModel(db) ||
  isBeforeMatterIds(db) ||
  isBeforeMoves(db) ||
  isBeforeTurnSearchCost(db);

/** Why a store of the old shape is not read: the desk helper's store step has not run on it (its log says why). */
export const NOT_MIGRATED =
  "not migrated: the desk helper's store step has not run on it (its log says why)";
