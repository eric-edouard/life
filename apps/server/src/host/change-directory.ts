import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { OWNER_DATA_DIR } from "../core/paths";
import { commitMemory } from "../memory/memory-files";
import { integrity, loadTruth } from "../memory/read-truth";
import { recordToldLife } from "../memory/told-life";
import { slug } from "../records/fields";

// Changes his directory (docs/glossary.md: his people, projects, areas and goals, in truth/) by his own words, through
// the connector's `change_directory`: the one place code writes truth/ for him. It edits text, never reserializes a
// file: a person or an area is one entry of its list (added at the end, or that one entry replaced), a project is its
// own file (new, or its frontmatter lines that change; the notes below are never touched), a goal is one numbered line
// of me.md, and what Life may keep is that one section. The result is checked by the same `integrity` as
// `bun life validate` on a copy of truth/ first; if it fails, nothing is written. Left out on purpose: deleting
// anything, reordering goals and editing a person's birthday, projects or chats (their YAML carries his comments).

const Strings = z.array(z.string().min(1)).optional();

export const DirectoryChange = z.object({
  action: z.enum(["add", "edit"]),
  aliases: Strings,
  area: z.string().optional(),
  handles: z
    .object({
      email: Strings,
      phone: Strings,
      telegram: z.string().optional(),
      whatsapp: Strings,
    })
    .optional(),
  id: z.string().optional(),
  kind: z.enum(["person", "project", "area", "goal", "may_keep"]),
  language: z.enum(["en", "fr", "th"]).optional(),
  name: z.string().min(1).optional(),
  number: z.int().min(1).optional(),
  people: Strings,
  relation: z.string().optional(),
  repos: Strings,
  said: z.string().min(1).max(8000),
  status: z.enum(["active", "waiting", "parked", "done"]).optional(),
  text: z.string().min(1).optional(),
});
export type DirectoryChange = z.infer<typeof DirectoryChange>;

const ENTRY = /^ {2}- /;
const NOTHING = /^\s*(#.*)?$/;
const CONTINUES = /^(\s|-)/;
const FRONT = /^---\n([\s\S]*?)\n---\n?/;
const GOAL = /^\d+\.\s/;
const MARKS = /\p{M}/gu;
const NOT_SLUG = /[^a-z0-9]+/g;
const DASHES = /^-|-$/g;

const refuse = (why: string): never => {
  throw new Error(`Not done: ${why}`);
};
const need = <T>(v: T | undefined, what: string): T =>
  v === undefined ? refuse(`${what} is needed.`) : v;

const union = (a: unknown, b: string[] = []) => [
  ...new Set([...((a as string[] | undefined) ?? []), ...b]),
];

/** The id a new entry takes: his `id`, else his name as a slug; the schema refuses what is not one. */
const idOf = (id: string | undefined, name: string) =>
  slug.parse(
    id ??
      name
        .normalize("NFD")
        .replace(MARKS, "")
        .toLowerCase()
        .replace(NOT_SLUG, "-")
        .replace(DASHES, "")
  );

interface Entry {
  aliases?: string[];
  handles?: Record<string, unknown>;
  id: string;
  name?: string;
}

const entriesOf = (text: string, key: "people" | "areas") =>
  ((Bun.YAML.parse(text) as Record<string, unknown[]>)[key] ?? []) as Entry[];

/** people.yaml / areas.yaml with `entry` added at the end of its list, or, with `id`, replacing that one entry (its comments go with it). */
function withEntry(
  text: string,
  key: "people" | "areas",
  entry: object,
  id?: string
) {
  const row = `  - ${JSON.stringify(entry)}`;
  if (!id) {
    const open = text.replace(
      new RegExp(`^${key}:\\s*\\[\\]\\s*$`, "m"),
      `${key}:`
    );
    return `${open.trimEnd()}\n${row}\n`;
  }
  const lines = text.split("\n");
  const starts = lines.flatMap((l, i) => (ENTRY.test(l) ? [i] : []));
  const entries = entriesOf(text, key);
  const k = entries.findIndex((e) => e.id === id);
  const start = starts[k];
  if (start === undefined || starts.length !== entries.length) {
    return refuse(`${key}.yaml has no entry ${id} this tool can edit.`);
  }
  let end = starts[k + 1] ?? lines.length;
  while (end - 1 > start && NOTHING.test(lines[end - 1] ?? "")) {
    end -= 1;
  }
  lines.splice(start, end - start, row);
  return lines.join("\n");
}

/** A project file with its frontmatter lines for `fields` set (others and the notes untouched). */
function withFrontmatter(text: string, fields: Record<string, unknown>) {
  const lines = (
    text.match(FRONT)?.[1] ?? refuse("the project has no frontmatter.")
  ).split("\n");
  for (const [key, value] of Object.entries(fields)) {
    const line = `${key}: ${JSON.stringify(value)}`;
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    let end = at + 1;
    while (at >= 0 && CONTINUES.test(lines[end] ?? "")) {
      end += 1;
    }
    lines.splice(at < 0 ? lines.length : at, at < 0 ? 0 : end - at, line);
  }
  return text.replace(FRONT, `---\n${lines.join("\n")}\n---\n`);
}

/** Where `## heading` is in me.md's lines: its line to the next `## ` (or the end), trailing blanks trimmed. */
function section(lines: string[], heading: string) {
  const at = lines.indexOf(`## ${heading}`);
  if (at < 0) {
    return;
  }
  let end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  end = end < 0 ? lines.length : end;
  while (end - 1 > at && !lines[end - 1]?.trim()) {
    end -= 1;
  }
  return { at, end };
}

/** me.md with a numbered goal added at the end of `## Goals`, or goal `number` replaced. */
function withGoal(me: string, text: string, number?: number) {
  const lines = me.trimEnd().split("\n");
  const goals = section(lines, "Goals");
  const body = text.replace(GOAL, "");
  if (!goals) {
    return number
      ? refuse("me.md has no goals.")
      : `${lines.join("\n")}\n\n## Goals\n1. ${body}\n`;
  }
  const starts = lines.flatMap((l, i) =>
    i > goals.at && i < goals.end && GOAL.test(l) ? [i] : []
  );
  if (number) {
    const start = starts[number - 1] ?? refuse(`there is no goal ${number}.`);
    lines.splice(
      start,
      (starts[number] ?? goals.end) - start,
      `${number}. ${body}`
    );
  } else {
    lines.splice(goals.end, 0, `${starts.length + 1}. ${body}`);
  }
  return `${lines.join("\n")}\n`;
}

/** me.md with `## What Life may keep` set to `text` (the section made at the end if it was not there). */
function withMayKeep(me: string, text: string) {
  const lines = me.trimEnd().split("\n");
  const kept = section(lines, "What Life may keep");
  if (!kept) {
    return `${lines.join("\n")}\n\n## What Life may keep\n${text}\n`;
  }
  lines.splice(kept.at + 1, kept.end - kept.at - 1, text);
  return `${lines.join("\n")}\n`;
}

type Read = (path: string) => string;

function projectWrite(a: DirectoryChange, read: Read) {
  const isAdd = a.action === "add";
  const id = isAdd ? idOf(a.id, need(a.name, "`name`")) : need(a.id, "`id`");
  const path = `projects/${id}.md`;
  if (isAdd) {
    if (existsSync(join(OWNER_DATA_DIR, "truth", path))) {
      refuse(`project ${id} exists: edit it.`);
    }
    return [
      path,
      `---\nschemaVersion: 1\nid: ${id}\nname: ${JSON.stringify(need(a.name, "`name`"))}\narea: ${need(a.area, "`area`")}\nstatus: ${a.status ?? "active"}\npeople: ${JSON.stringify(a.people ?? [])}\nchats: []\nrepos: ${JSON.stringify(a.repos ?? [])}\n---\n`,
    ] as const;
  }
  const text = read(path);
  const old = Bun.YAML.parse(text.match(FRONT)?.[1] ?? "") as Record<
    string,
    unknown
  >;
  return [
    path,
    withFrontmatter(text, {
      ...(a.name && { name: a.name }),
      ...(a.area && { area: a.area }),
      ...(a.status && { status: a.status }),
      ...(a.people && { people: union(old.people, a.people) }),
      ...(a.repos && { repos: union(old.repos, a.repos) }),
    }),
  ] as const;
}

/** A person's or an area's entry as it will read: what was there, with his changes (handles and aliases added to, never replaced). */
function entryWrite(a: DirectoryChange, read: Read) {
  const key = a.kind === "person" ? "people" : "areas";
  const file = `${key}.yaml`;
  const text = read(file);
  const isAdd = a.action === "add";
  const id = isAdd ? idOf(a.id, need(a.name, "`name`")) : need(a.id, "`id`");
  const was: Entry = isAdd
    ? { id }
    : (entriesOf(text, key).find((e) => e.id === id) ??
      refuse(`${a.kind} ${id} is not in his directory.`));
  const entry: Record<string, unknown> = {
    ...was,
    name: a.name ?? need(was.name, "`name`"),
  };
  if (a.kind === "person") {
    const h = a.handles ?? {};
    const old = was.handles ?? {};
    const handles = {
      ...old,
      ...(h.email && { email: union(old.email, h.email) }),
      ...(h.phone && { phone: union(old.phone, h.phone) }),
      ...(h.whatsapp && { whatsapp: union(old.whatsapp, h.whatsapp) }),
      ...(h.telegram && { telegram: h.telegram }),
    };
    Object.assign(entry, {
      ...(a.aliases && { aliases: union(was.aliases, a.aliases) }),
      ...(Object.keys(handles).length > 0 && { handles }),
      ...(a.language && { language: a.language }),
      ...(a.relation && { relation: a.relation }),
    });
  }
  return [file, withEntry(text, key, entry, isAdd ? undefined : id)] as const;
}

/** The one file this change writes: its path under truth/ and its new text. Pure: nothing is written. */
function writeOf(a: DirectoryChange, read: Read) {
  if (a.kind === "goal") {
    const number = a.action === "add" ? undefined : need(a.number, "`number`");
    return [
      "me.md",
      withGoal(read("me.md"), need(a.text, "`text`"), number),
    ] as const;
  }
  if (a.kind === "may_keep") {
    return [
      "me.md",
      withMayKeep(read("me.md"), need(a.text, "`text`")),
    ] as const;
  }
  return a.kind === "project" ? projectWrite(a, read) : entryWrite(a, read);
}

/** What the change is called in the commit and in what Life keeps of his words. */
const whatOf = (a: DirectoryChange) =>
  `${a.action} ${a.kind} ${a.id ?? a.name ?? a.number ?? ""}`.trim();

/**
 * Applies one change he asked for in his own words (`said`): validated on a copy of truth/ first, then written, kept as
 * what he told Life, and committed in his data repo. Returns what changed; throws, changing nothing, when it is refused.
 */
export async function changeDirectory(a: DirectoryChange) {
  const truth = join(OWNER_DATA_DIR, "truth");
  const [path, text] = writeOf(a, (p) =>
    existsSync(join(truth, p))
      ? readFileSync(join(truth, p), "utf8")
      : refuse(`truth/${p} is not there.`)
  );
  const scratch = mkdtempSync(join(tmpdir(), "life-directory-"));
  try {
    cpSync(truth, join(scratch, "truth"), { recursive: true });
    writeFileSync(join(scratch, "truth", path), text);
    const issues = integrity(await loadTruth(scratch));
    if (issues.length > 0) {
      refuse(`his directory would not be consistent: ${issues.join("; ")}`);
    }
  } catch (e) {
    const { message } = e as Error;
    throw new Error(
      message.startsWith("Not done")
        ? message
        : `Not done: the result would not read as his truth/ (${message}).`,
      { cause: e }
    );
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
  mkdirSync(join(truth, "projects"), { recursive: true });
  writeFileSync(join(truth, path), text);
  const what = whatOf(a);
  recordToldLife(a.said, `Changed his directory: ${what}`);
  commitMemory(["truth"], `Truth, by his words: ${what}\n\n${a.said}`);
  return `Done: ${what}.`;
}
