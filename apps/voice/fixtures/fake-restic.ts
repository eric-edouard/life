// A fake restic for restic.test.ts, compiled there so it runs as a binary on any OS. Logs each call (and whether the
// password came) to `calls` beside it, answers like restic: before `init`, exit 10 (or an older restic's exit 1 and
// words while `old` exists); a JSON summary for `backup`, exit 1 while `fail` exists, exit 3 while `partial` does.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const dir = dirname(process.execPath);
const there = (name: string) => existsSync(join(dir, name));
const args = process.argv.slice(2);
const { RESTIC_PASSWORD, RESTIC_REPOSITORY } = process.env;
appendFileSync(
  join(dir, "calls"),
  `${args.join(" ")} pw=${RESTIC_PASSWORD} repo=${RESTIC_REPOSITORY}\n`
);
if (args[0] === "cat" && !there("inited")) {
  if (there("old")) {
    console.error("Fatal: unable to open config file: stat: no such file");
  }
  process.exit(there("old") ? 1 : 10);
}
if (args[0] === "init") {
  writeFileSync(join(dir, "inited"), "");
}
if (args[0] === "backup") {
  if (there("fail")) {
    console.error("Fatal: repository is locked");
    process.exit(1);
  }
  console.log('{"message_type":"status"}');
  console.log(
    '{"message_type":"summary","data_added":1234,"snapshot_id":"5f2d0e1c9a"}'
  );
  process.exit(there("partial") ? 3 : 0);
}
