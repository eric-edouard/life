// Recent crashes, hangs, exceptions and errors (the app's and the server's), for reading. Read-only
// on the archive:
//   DATABASE_PATH="$HOME/Library/Application Support/lifelog/archive.sqlite" bun run diagnostics:recent 1
// The argument is days (default 14). `--json` prints one group per signature instead: ids (newest
// first), kinds, count, builds, the app binary UUIDs (the dSYMs to symbolicate with) and first and
// last seen. Symbolicate one with `bun run symbolicate <id>` from the repo root.
import { connect } from "@life/voice-db";
import {
  appBinaryUUIDs,
  attributedStack,
  frameLabel,
  listDiagnostics,
  problemLines,
  topFrames,
} from "../src/diagnostics";

const url = process.env.DATABASE_PATH;
if (!url) {
  throw new Error("DATABASE_PATH is not set");
}
const args = process.argv.slice(2);
const json = args.includes("--json");
const days = Number(args.find((a) => a !== "--json") ?? 14);
// Read-only: the file is the live archive.
const db = connect(url, { readonly: true });
const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
const problems = listDiagnostics(db, { limit: 2000, since }).filter(
  (d) => d.kind !== "metrics"
);
db.$client.close();

// An app error stands for its repeats within the hour.
const occurrences = (items: typeof problems) =>
  items.reduce((sum, d) => sum + (d.error?.count ?? 1), 0);
const groups = [...Map.groupBy(problems, (d) => d.signature)].sort(
  (a, b) => occurrences(b[1]) - occurrences(a[1])
);
const buildsOf = (items: typeof problems) => [
  ...new Set(items.map((d) => `${d.build.appVersion} (${d.build.appBuild})`)),
];

if (json) {
  const out = groups.map(([signature, items]) => ({
    binaryUUIDs: [...new Set(items.flatMap(appBinaryUUIDs))],
    builds: buildsOf(items),
    count: occurrences(items),
    firstSeen: items.at(-1)?.receivedAt,
    ids: items.map((d) => d.id),
    kinds: [...new Set(items.map((d) => d.kind))],
    lastSeen: items[0]?.receivedAt,
    signature,
  }));
  console.log(JSON.stringify({ days, groups: out }, null, 2));
  process.exit(0);
}

if (problems.length === 0) {
  console.log(
    `No crashes, hangs, exceptions or errors in the last ${days} days.`
  );
  process.exit(0);
}

console.log(`Counts by signature, last ${days} days:\n`);
for (const [signature, items] of groups) {
  console.log(`${String(occurrences(items)).padStart(4)}x  ${signature}`);
  console.log(
    `       builds ${buildsOf(items).join(", ")}; last ${items[0]?.receivedAt}`
  );
}

console.log("\nMost recent:\n");
for (const d of problems.slice(0, 20)) {
  const { build } = d;
  console.log(`${d.receivedAt}  ${d.kind}  ${d.id}`);
  console.log(
    `  ${build.appVersion} (${build.appBuild}), ${build.os}, ${build.device}`
  );
  for (const line of problemLines(d, 8)) {
    console.log(`  ${line}`);
  }
  for (const [i, frame] of topFrames(attributedStack(d), 8).entries()) {
    console.log(`  ${String(i).padStart(2)}  ${frameLabel(frame)}`);
  }
  console.log("");
}
