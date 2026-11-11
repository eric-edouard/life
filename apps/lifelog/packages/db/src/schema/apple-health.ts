import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, instant } from "./columns";

// Its own cursor: measurements never wake the voice change feed.
export const appleHealth = sqliteTable("apple_health", {
  activity: text("activity"),
  createdAt,
  endAt: instant("end_at").notNull(),
  id: text("id").notNull().unique(),
  kcal: real("kcal"),
  kind: text("kind").notNull(),
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  stage: text("stage"),
  startAt: instant("start_at").notNull(),
  value: real("value"),
});
