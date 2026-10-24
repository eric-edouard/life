// The archive's consistency check (src/archive-health.ts): every count should be 0. Read-only.
//   DATABASE_PATH="$HOME/Library/Application Support/lifelog/archive.sqlite" bun run check:archive
// Exits 1 when an invariant is broken.

import { connect } from "@lifelog/db";
import { archiveHealth } from "../src/archive-health";

const url = process.env.DATABASE_PATH;
if (!url) {
  throw new Error("DATABASE_PATH is not set");
}
// Read-only: the file is the live archive.
const db = connect(url, { readonly: true });
const health = archiveHealth(db);
db.$client.close();
console.log(JSON.stringify(health, null, 2));
process.exit(Object.values(health).some((n) => n > 0) ? 1 : 0);
