import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clock } from "./core/clock";
import { appendJsonl } from "./core/files";
import { DATA } from "./core/paths";
import { systemZone } from "./core/platform";
import { git } from "./core/proc";
import { integrity, loadTruth } from "./memory/truth";
import { Zone } from "./schema";

// A new install's data: the smallest truth that validates (only the owner), his zone from now on, and the data repo
// the nightly commits to. Everything else is learned from his sources; goals, people and projects come when he says.

export interface Owner {
  email: string[];
  name: string;
  phone: string[];
}

const yaml = (key: string, list: unknown[]) =>
  `schemaVersion: 1\n${key}: ${list.length ? `\n${list.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}` : "[]"}\n`;

/** Whether `dir` has nothing in it (or isn't there): the one folder Life writes a new whole into. */
export const isEmpty = (dir: string) =>
  !existsSync(dir) || readdirSync(dir).length === 0;

/** Whether `data` holds an owner's truth: Life is set up there. */
export const started = (data = DATA) =>
  existsSync(join(data, "truth", "people.yaml"));

/** Creates `data` for a new owner; refuses a folder that is not empty. */
export async function init(owner: Owner, data = DATA, now = clock()) {
  const truth = join(data, "truth");
  if (!isEmpty(data)) {
    throw new Error(`${data} is not empty: nothing was changed`);
  }
  await mkdir(join(truth, "projects"), { recursive: true });
  await mkdir(join(data, "memory"), { recursive: true });
  const me = {
    handles: { email: owner.email, phone: owner.phone },
    id: "me",
    name: owner.name,
  };
  await Promise.all([
    writeFile(join(truth, "people.yaml"), yaml("people", [me])),
    writeFile(join(truth, "chats.yaml"), yaml("chats", [])),
    writeFile(join(truth, "areas.yaml"), yaml("areas", [])),
    writeFile(join(truth, "projects", ".gitkeep"), ""),
    writeFile(join(truth, "me.md"), `# Me\n\n${owner.name}.\n`),
    appendJsonl(join(data, "memory", "zones.jsonl"), Zone, [
      { from: now.toISOString(), schemaVersion: 1, tz: systemZone() ?? "UTC" },
    ]),
  ]);
  const issues = integrity(await loadTruth(data));
  if (issues.length > 0) {
    throw new Error(`the new truth does not validate: ${issues.join("; ")}`);
  }
  git(data, ["init", "-q"]);
  // The nightly commits as Life: a new Mac may have no identity for commits at all.
  git(data, ["config", "user.name", "Life"]);
  git(data, ["config", "user.email", "life@localhost"]);
  git(data, ["add", "-A"]);
  git(data, ["commit", "-q", "-m", "Life: start"]);
}
