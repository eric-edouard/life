// Fails if a name, phone, email, handle or chat id from his truth/ appears in a tracked file of the current repo
// (`bun run check`; lifelog runs it too), limited to the git pathspecs given as arguments. Skips when his data is
// absent (CI, other machines).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "server/src/core/paths";
import { handlesOf, loadTruth } from "server/src/memory/truth";

if (!existsSync(join(DATA, "truth"))) {
  console.log(`scrub: skipped, no ${DATA}/truth`);
  process.exit(0);
}
const { people, chats } = await loadTruth();
const WORDS = "/usr/share/dict/words";
const NOT_A_NAME = /[(\d]/;
const PHONE = /^\+?\d+$/;
const english = new Set(
  existsSync(WORDS)
    ? (await Bun.file(WORDS).text()).toLowerCase().split("\n")
    : []
);
/** A surname: the last word of a full name ("Ann Smith", not "Shop (team)"), unless it is an English word. */
const surname = (name: string) => {
  const last = name.split(" ").at(-1) ?? "";
  const plain = name.includes(" ") && !NOT_A_NAME.test(name);
  return plain && !english.has(last.toLowerCase()) ? [last] : [];
};
/** A phone matches with or without its "+" and spaces, dots or dashes between digits. */
const term = (t: string) =>
  PHONE.test(t)
    ? t.replace("+", "").split("").join("[ .-]?")
    : RegExp.escape(t);
const terms = new Set(
  [
    ...people.flatMap((p) => [p.name, ...p.aliases, ...surname(p.name)]),
    ...people.flatMap(handlesOf),
    ...chats.flatMap((c) => [c.id, c.whatsapp ?? ""]),
  ].filter((t) => t.length > 2)
);
const pattern = `(?<![\\p{L}\\d])(${[...terms].map(term).join("|")})(?![\\p{L}\\d])`;
// git grep reads the tracked text files (binaries skipped); exit 1 means no match.
const grep =
  await Bun.$`git grep -I -n -o -P ${pattern} -- ${process.argv.slice(2)}`
    .nothrow()
    .quiet();
if (grep.exitCode > 1) {
  throw new Error(`scrub: git grep failed: ${grep.stderr}`);
}
const hits = grep.stdout.toString().trim();
if (hits) {
  console.error(`scrub: personal traces\n${hits}`);
  process.exit(1);
}
console.log(`scrub: clean (${terms.size} terms)`);
