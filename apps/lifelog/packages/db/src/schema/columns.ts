import { randomUUID } from "node:crypto";
import { clock } from "@life/server/src/core/clock";
import { bytesOf, vectorOf } from "@life/server/src/core/embedder";
import { customType, integer, text } from "drizzle-orm/sqlite-core";

// SQLite, one file, one writer (docs/architecture.md). Instants are epoch milliseconds (Date in
// code), ids text uuids, JSON text read and written by Drizzle, booleans 0 and 1.
export const instant = (name: string) =>
  integer(name, { mode: "timestamp_ms" });
export const boolean = (name: string) => integer(name, { mode: "boolean" });
export const json = <T = unknown>(name: string) =>
  text(name, { mode: "json" }).$type<T>();
export const uuid = (name: string) => text(name);
export const newId = () => randomUUID();

// A vector as Life's core stores it: scored in JS (search.ts), never by the database.
export const vector = customType<{ data: number[]; driverData: Uint8Array }>({
  dataType: () => "blob",
  fromDriver: (bytes) => Array.from(vectorOf(bytes)),
  toDriver: bytesOf,
});

export const createdAt = instant("created_at").notNull().$defaultFn(clock);

export const updatedAt = instant("updated_at")
  .notNull()
  .$defaultFn(clock)
  .$onUpdate(clock);
