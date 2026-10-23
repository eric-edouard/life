import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  // Timestamped file names: the journal index ran one behind the numbered files, so `db:generate` kept
  // reusing an existing number and overwriting its snapshot.
  migrations: { prefix: "timestamp" },
  out: "./src/migrations",
  schema: "./src/schema",
});
