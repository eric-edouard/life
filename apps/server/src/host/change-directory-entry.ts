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
import { isCollection, isMap, isSeq, parseDocument, type YAMLMap } from "yaml";
import { z } from "zod";
import { writeWhole } from "../core/files";
import { oneAtATimeAcross } from "../core/lock";
import { LIFE_STATE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { commitMemory } from "../memory/memory-files";
import {
  directoryPartiesOf,
  type Entry,
  entriesOf,
  integrity,
  loadTruth,
} from "../memory/read-truth";
import { recordToldLife } from "../memory/told-life";
import { PERSON } from "../memory/units";
import { slug } from "../records/fields";
import { OrganizationPerson, PictureFrom } from "../records/truth";
import { listRow } from "./init";

// Changes his directory (docs/glossary.md: his people, organizations, projects, areas and goals, in truth/) by his own
// words, through the connector's `change_directory_entry`, his card's tap (`addDirectoryEntryByHisWord`,
// `addOrganizationPersonByHisWord`) or `bun life
// change-directory-entry`: the one place code writes truth/ for him. It edits text, never reserializes a
// file: a person, an organization or an area is one entry of its list (added at the end, or that one entry edited in
// place: only its fields that change are set, through the `yaml` package's Document, so his comments and spacing stay;
// Bun.YAML only parses and prints, with no document to edit), a project is its
// own file (new, or its frontmatter lines that change; the notes below are never touched), a goal is one numbered line
// of me.md, and what Life may keep is that one section. The result is checked by the same `integrity` as
// `bun life validate` on a copy of truth/ first; if it fails, nothing is written. Left out on purpose: deleting
// anything, reordering goals and editing a person's birthday, projects or chats (their YAML carries his comments).

const Strings = z.array(z.string().min(1)).optional();

export const DirectoryEntryChange = z.object({
  action: z.enum(["add", "edit"]),
  aliases: Strings,
  area: z.string().optional(),
  domains: Strings,
  handles: z
    .object({
      email: Strings,
      github: z.string().optional(),
      phone: Strings,
      telegram: z.string().optional(),
      voice: z.uuid().optional(),
      whatsapp: Strings,
    })
    .optional(),
  id: z.string().optional(),
  kind: z.enum([
    "person",
    "organization",
    "project",
    "area",
    "goal",
    "may_keep",
  ]),
  language: z.enum(["en", "fr", "th"]).optional(),
  name: z.string().min(1).optional(),
  number: z.int().min(1).optional(),
  /** A project's people (ids), or an organization's (each with a role, and `until` once they left). */
  people: z.array(z.union([z.string().min(1), OrganizationPerson])).optional(),
  pictureFrom: PictureFrom.optional(),
  projects: Strings,
  relation: z.string().optional(),
  repos: Strings,
  said: z.string().min(1).max(8000),
  status: z.enum(["active", "waiting", "parked", "done"]).optional(),
  text: z.string().min(1).optional(),
});
export type DirectoryEntryChange = z.infer<typeof DirectoryEntryChange>;
type Change = DirectoryEntryChange;

const NEWLINE = /[\r\n]/;
const HEADING = /^#{1,2} /m;
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

/** A name as a slug: its latin letters and digits, lowercase, joined by dashes; empty when it has none (Thai script). */
const slugOf = (name: string) =>
  name
    .normalize("NFD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(NOT_SLUG, "-")
    .replace(DASHES, "");

/** The id a new entry takes: his `id`, else his name as a slug; the schema refuses what is not one. */
function idOf(id: string | undefined, name: string) {
  const made = id ?? slugOf(name);
  return made ? slug.parse(made) : refuse("give an `id`.");
}

/** The list each kind of entry is in, its file `<list>.yaml`. */
const LISTS = {
  area: "areas",
  organization: "organizations",
  person: "people",
} as const;
type List = (typeof LISTS)[keyof typeof LISTS];

type Row = Record<string, unknown>;
const isPlain = (v: unknown): v is Row =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Sets in `map` only what differs from `was` to `next`, a nested map field by field: every other node keeps its comments and style. */
function setChanged(
  doc: ReturnType<typeof parseDocument>,
  map: YAMLMap,
  was: Row,
  next: Row
) {
  for (const [k, v] of Object.entries(next)) {
    const old = map.get(k, true);
    if (isPlain(v) && isPlain(was[k]) && isMap(old)) {
      setChanged(doc, old, was[k], v);
    } else if (JSON.stringify(v) !== JSON.stringify(was[k])) {
      const node = doc.createNode(v);
      if (isCollection(old) && isCollection(node)) {
        node.flow = old.flow;
      }
      map.set(k, node);
    }
  }
  for (const k of Object.keys(was).filter((x) => !(x in next))) {
    map.delete(k);
  }
}

/** The entry `id` of `key`'s list in a parsed `doc`, with its place in the text it was parsed from. */
function entryNode(
  doc: ReturnType<typeof parseDocument>,
  key: List,
  id: string
) {
  const list = doc.get(key);
  const node = isSeq(list)
    ? list.items.find((i) => isMap(i) && i.get("id") === id)
    : undefined;
  return isMap(node) && node.range
    ? { node, range: node.range }
    : refuse(`${key}.yaml has no entry ${id} this tool can edit.`);
}

/**
 * A list's file with `entry` added at the end of its list, or, with `id`, that one entry edited in place: only its
 * fields that change are written, so his comments and the rest of the file stay as they are.
 */
function withEntry(
  text: string,
  key: List,
  entry: Row,
  edit?: { id: string; was: Row }
) {
  if (!edit) {
    const open = text.replace(
      new RegExp(`^${key}:\\s*\\[\\]\\s*$`, "m"),
      () => `${key}:`
    );
    return `${open.trimEnd()}\n${listRow(entry)}\n`;
  }
  const doc = parseDocument(text);
  const { node, range } = entryNode(doc, key, edit.id);
  setChanged(doc, node, edit.was, entry);
  // The edited entry alone is taken from the new text: the rest keeps his own spacing, which the printer would change.
  const out = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
  const [start, , end] = entryNode(parseDocument(out), key, edit.id).range;
  return text.slice(0, range[0]) + out.slice(start, end) + text.slice(range[2]);
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
  return text.replace(FRONT, () => `---\n${lines.join("\n")}\n---\n`);
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
  if (NEWLINE.test(body)) {
    refuse("a goal is one line.");
  }
  kept(body);
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

/** A text that lands in me.md: never a line that would start a section of its own. */
const kept = (text: string) =>
  HEADING.test(text) ? refuse("a line may not start with `#`.") : text;

type Read = (path: string) => string;

/** The people `a` names, each as the kind of entry takes them: a project's by id, an organization's with a role. */
function peopleOf<T>(
  a: Change,
  isTheKind: (p: unknown) => p is T,
  what: string
) {
  return a.people?.map((p) =>
    isTheKind(p) ? p : refuse(`a ${a.kind}'s \`people\` are ${what}.`)
  );
}
const isId = (p: unknown): p is string => typeof p === "string";
const isMember = (p: unknown): p is z.infer<typeof OrganizationPerson> =>
  typeof p === "object" && p !== null;

function projectWrite(a: DirectoryEntryChange, read: Read) {
  const isAdd = a.action === "add";
  const people = peopleOf(a, isId, "ids");
  const id = isAdd ? idOf(a.id, need(a.name, "`name`")) : need(a.id, "`id`");
  const path = `projects/${id}.md`;
  if (isAdd) {
    if (existsSync(join(OWNER_DATA_DIR, "truth", path))) {
      refuse(`project ${id} exists: edit it.`);
    }
    return [
      path,
      `---\nschemaVersion: 1\nid: ${id}\nname: ${JSON.stringify(need(a.name, "`name`"))}\narea: ${JSON.stringify(need(a.area, "`area`"))}\nstatus: ${a.status ?? "active"}\npeople: ${JSON.stringify(people ?? [])}\nchats: []\nrepos: ${JSON.stringify(a.repos ?? [])}\n---\n`,
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
      ...(people && { people: union(old.people, people) }),
      ...(a.repos && { repos: union(old.repos, a.repos) }),
    }),
  ] as const;
}

/** His handles over the ones there: lists added to, never replaced. */
function handlesWith(
  all: Record<string, unknown>,
  h: NonNullable<DirectoryEntryChange["handles"]>
) {
  // `lifelog`, `voice`'s old name, goes when he gives `voice` (PLAN.md: removed with the old name in the follow-up PR).
  const { lifelog: _old, ...rest } = all;
  const old = h.voice ? rest : all;
  return {
    ...old,
    ...(h.email && { email: union(old.email, h.email) }),
    ...(h.phone && { phone: union(old.phone, h.phone) }),
    ...(h.whatsapp && { whatsapp: union(old.whatsapp, h.whatsapp) }),
    ...(h.github && { github: h.github }),
    ...(h.telegram && { telegram: h.telegram }),
    ...(h.voice && { voice: h.voice }),
  };
}

/** Who is there, his word: `people` by id, each one he names replacing that one's role and `until`. */
const peopleWith = (
  old: { id: string }[] | undefined,
  people: { id: string }[]
) => [
  ...(old ?? []).filter((p) => !people.some((x) => x.id === p.id)),
  ...people,
];

/** An organization's own fields as they will read: its domains, projects and people, his word over what was there. */
const organizationFieldsOf = (a: Change, was: Entry) => ({
  ...(a.domains && { domains: union(was.domains, a.domains) }),
  ...(a.people && {
    people: peopleWith(
      was.people,
      peopleOf(a, isMember, "each an id with a role") ?? []
    ),
  }),
  ...(a.projects && { projects: union(was.projects, a.projects) }),
});

/** A person's, an organization's or an area's entry as it will read: what was there, with his changes (lists added to, never replaced). */
function entryWrite(a: Change, read: Read) {
  const key = LISTS[a.kind as keyof typeof LISTS];
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
  if (a.kind === "person" || a.kind === "organization") {
    const handles = handlesWith(was.handles ?? {}, a.handles ?? {});
    Object.assign(entry, {
      ...(a.aliases && { aliases: union(was.aliases, a.aliases) }),
      ...(Object.keys(handles).length > 0 && { handles }),
      ...(a.relation && { relation: a.relation }),
      ...(a.pictureFrom && { pictureFrom: a.pictureFrom }),
    });
  }
  if (a.kind === "person" && a.language) {
    entry.language = a.language;
  }
  if (a.kind === "organization") {
    Object.assign(entry, organizationFieldsOf(a, was));
  }
  return [
    file,
    withEntry(text, key, entry, isAdd ? undefined : { id, was: { ...was } }),
  ] as const;
}

/** The one file this change writes: its path under truth/ and its new text. Pure: nothing is written. */
function writeOf(a: Change, read: Read) {
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
      withMayKeep(read("me.md"), kept(need(a.text, "`text`"))),
    ] as const;
  }
  return a.kind === "project" ? projectWrite(a, read) : entryWrite(a, read);
}

/** What the change is called in the commit and in what Life keeps of his words. */
const whatOf = (a: Change) =>
  `${a.action} ${a.kind} ${a.id ?? a.name ?? ("number" in a ? a.number : undefined) ?? ""}`.trim();

/** One change at a time, across processes (the connector's, the main session's, the CLI's): two calls would each read the file the other is about to write. */
const inTurn = oneAtATimeAcross(join(LIFE_STATE_DIR, "directory.lock"));

/**
 * Applies one change he asked for in his own words (`said`): validated on a copy of truth/ first, then written, kept as
 * what he told Life, and committed in his data repo. Returns what changed; throws, changing nothing, when it is refused.
 */
export function changeDirectoryEntry(a: Change) {
  return inTurn(() => apply(a));
}

/**
 * Adds a person or an organization to his directory by the name he gave answering a check (`namedIn`, the name card's
 * "Organization"), with what else he said of it (`relation`); gives its ref. Its id is the name's slug, numbered past one
 * taken by either kind (a second "Sam"), or its kind for a name with no latin letters.
 */
export async function addDirectoryEntryByHisWord(
  kind: "person" | "organization",
  name: string,
  said: string,
  fields: { relation?: string } = {}
) {
  // ponytail: ids read outside the queue: two adds of one name at once, the second refused as a duplicate; its retry finds
  // the name in truth/. Fine for one owner; read inside `apply` if answers ever race.
  const taken = new Set(directoryPartiesOf(await loadTruth()).map((p) => p.id));
  const base = slugOf(name) || kind;
  let id = base;
  for (let n = 2; taken.has(id); n += 1) {
    id = `${base}-${n}`;
  }
  await changeDirectoryEntry({
    action: "add",
    id,
    kind,
    name,
    said,
    ...fields,
  });
  return `person:${id}`;
}

/**
 * Adds a person of his directory to an organization of it with a role, by his Yes on an at organization card
 * (life#874): that one member of its `people`, through `changeDirectoryEntry`; refused when they are there already.
 */
export async function addOrganizationPersonByHisWord(
  organization: string,
  person: string,
  role: string,
  said: string
) {
  const id = organization.replace(PERSON, "");
  const member = person.replace(PERSON, "");
  const o = (await loadTruth()).organizations.find((x) => x.id === id);
  if (o?.people.some((m) => m.id === member)) {
    refuse(`${member} is already at ${id}.`);
  }
  return changeDirectoryEntry({
    action: "edit",
    id,
    kind: "organization",
    people: [{ id: member, role }],
    said,
  });
}

/** An empty organizations.yaml: the one list file a directory may not hold yet. */
const NO_ORGANIZATIONS = "schemaVersion: 1\norganizations: []\n";

async function apply(a: Change) {
  const truth = join(OWNER_DATA_DIR, "truth");
  const [path, text] = writeOf(a, (p) => {
    if (existsSync(join(truth, p))) {
      return readFileSync(join(truth, p), "utf8");
    }
    return p === "organizations.yaml"
      ? NO_ORGANIZATIONS
      : refuse(`truth/${p} is not there.`);
  });
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
  writeWhole(join(truth, path), text);
  const what = whatOf(a);
  recordToldLife(a.said);
  try {
    commitMemory(["truth"], `Truth, by his words: ${what}\n\n${a.said}`);
  } catch {
    // Written is done: git may be busy (the night holds its index); the night's run commits truth/ too.
    return `Done: ${what}; committed with the night's run.`;
  }
  return `Done: ${what}.`;
}
