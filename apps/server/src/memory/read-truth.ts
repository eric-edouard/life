import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { OWNER_DATA_DIR } from "../core/paths";
import { git, gitOut } from "../core/proc";
import { CONTACT_PREFIX, INFERRED_PREFIX } from "../records/observation";
import {
  type Area,
  AreasFile,
  type Chat,
  ChatsFile,
  type DirectoryParty,
  ME,
  type Organization,
  OrganizationsFile,
  PeopleFile,
  type Person,
  Project,
} from "../records/truth";

/** The owner as an entity ref: the center of his memory. */
export const OWNER = `person:${ME}`;
/** The people other than the owner among an observation's entity refs. */
export const othersIn = (subjects: string[]) =>
  subjects.filter((e) => e.startsWith("person:") && e !== OWNER);
/** The first paragraph of truth/me.md. */
const ABOUT = /^# Me\n\n(.+(?:\n.+)*)/;
/** truth/me.md's goals: the block under `## Goals`, his words in his priority order. */
const GOALS = /(?:^|\n)## Goals\n([\s\S]*?)(?=\n## |$)/;
/** truth/me.md's `## What Life may keep`: his own words on what Life may and may not keep. */
const MAY_KEEP = /(?:^|\n)## What Life may keep\n([\s\S]*?)(?=\n## |$)/;
/** The projects a goal serves: the ids in backticks it names. */
const PROJECT_ID = /`([a-z0-9-]+)`/g;
/** Where a numbered goal starts. */
const GOAL_START = /^\d+\.\s/m;
/** A bracket holding only project ids, with the space before it: "(`shop`, `farm`)". */
const ID_BRACKET = /\s*\((?:\s*`[a-z0-9-]+`\s*,?)+\)/g;
const SPACES = /\s+/g;
const SPACE_BEFORE_STOP = / ([.,;:!?])/g;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export interface Truth {
  areas: Area[];
  chats: Chat[];
  /** truth/me.md, read once: all of it, its first paragraph, his goals and what Life may keep (none: no limit). */
  me: { about?: string; goals?: string; mayKeep?: string; text: string };
  /** truth/organizations.yaml; none when the file is not there. */
  organizations: Organization[];
  people: Person[];
  projects: (Project & { notes: string })[];
}

/** How much of a project's notes (the body of `truth/projects/<id>.md`) an area page's hold and an agent's packet show, cut at a word (`clip`). */
export const PROJECT_NOTES_MAX = 1500;

/** A project's one line, as the area read, an area page's hold and an agent's packet show it: name, id, status, deadlines. */
export const projectHeaderOf = (
  p: Pick<Project, "deadlines" | "id" | "name" | "status">
) =>
  `Project ${p.name} (${p.id}, ${p.status})${p.deadlines.map((d) => `; ${d.date}: ${d.what}`).join("")}`;

/** Everyone in his directory: its people, then its organizations (`DirectoryParty`). The one join of the two lists. */
export const directoryPartiesOf = ({
  organizations,
  people,
}: Pick<Truth, "organizations" | "people">): DirectoryParty[] => [
  ...people,
  ...organizations,
];

/** His directory is new: it holds only him and no goals (the setup interview, `docs/use/connect.md`). */
export const isDirectoryNew = (truth: Pick<Truth, "me" | "people">) =>
  truth.people.length === 1 && !truth.me.goals;

export const readMe = (text: string): Truth["me"] => ({
  about: text.match(ABOUT)?.[1]?.replaceAll("\n", " "),
  goals: text.match(GOALS)?.[1]?.trim(),
  mayKeep: text.match(MAY_KEEP)?.[1]?.trim() || undefined,
  text,
});

async function yaml(path: string): Promise<unknown> {
  return parse(await Bun.file(path).text());
}

function frontmatter(text: string, path: string) {
  const [, head, body] = text.match(FRONTMATTER) ?? [];
  if (head === undefined) {
    throw new Error(`${path}: missing --- frontmatter ---`);
  }
  return { body: (body ?? "").trim(), data: parse(head) };
}

/** His truth/ folder. */
export const TRUTH = join(OWNER_DATA_DIR, "truth");

/** truth/me.md, read fresh. */
export const loadMe = async (data = OWNER_DATA_DIR) =>
  readMe(await Bun.file(join(data, "truth", "me.md")).text());

/** What truth/me.md says Life may keep, read now: none when the section or the file is absent. */
export function readMayKeep(data = OWNER_DATA_DIR) {
  const file = join(data, "truth", "me.md");
  return existsSync(file)
    ? readMe(readFileSync(file, "utf8")).mayKeep
    : undefined;
}

export async function loadTruth(data = OWNER_DATA_DIR): Promise<Truth> {
  const dir = join(data, "truth");
  const { people } = PeopleFile.parse(await yaml(join(dir, "people.yaml")));
  const { chats } = ChatsFile.parse(await yaml(join(dir, "chats.yaml")));
  const { areas } = AreasFile.parse(await yaml(join(dir, "areas.yaml")));
  const orgs = join(dir, "organizations.yaml");
  const { organizations } = existsSync(orgs)
    ? OrganizationsFile.parse(await yaml(orgs))
    : { organizations: [] };
  const names = (await readdir(join(dir, "projects")))
    .filter((n) => n.endsWith(".md"))
    .sort();
  const projects = await Promise.all(
    names.map(async (name) => {
      const path = join(dir, "projects", name);
      const { data: head, body } = frontmatter(
        await Bun.file(path).text(),
        path
      );
      return { ...Project.parse(head), notes: body };
    })
  );
  return {
    areas,
    chats,
    me: await loadMe(data),
    organizations,
    people,
    projects,
  };
}

/** A party's phones and emails (their `whatsapp`, `phone` and `email`): the handles with a contact key. */
export function phonesAndEmailsOf(
  p: Pick<DirectoryParty, "handles">
): string[] {
  const { whatsapp, phone, email } = p.handles;
  return [...whatsapp, ...phone, ...email.map((h) => h.toLowerCase())];
}

/** Every handle a party has, normalized the way senders are looked up: emails lower-cased. */
export function handlesOf(p: Pick<DirectoryParty, "handles">): string[] {
  const { github, telegram, voice } = p.handles;
  return [
    ...phonesAndEmailsOf(p),
    ...(github ? [github.toLowerCase()] : []),
    ...(voice ? [voice] : []),
    ...(telegram ? [telegram] : []),
  ];
}

/**
 * A project's people and chats as the directory holds them, for an agent on it: its `people` ids in order, then whoever
 * lists the project in their own `projects` (the two directions are independent); its chats by the key a wait's `chat`
 * filter compares, exactly. A WhatsApp chat's key is its `whatsapp` id or its own id when that is one (read from the Mac app); a room id alone is
 * not sure (a bridged network's events carry the room the copy came from, which a room written down under Beeper no
 * longer is after the cutover). Null when the directory has no such project.
 */
export function projectPeopleAndChatsOf(
  truth: Pick<Truth, "chats" | "organizations" | "people" | "projects">,
  project: string
) {
  const { chats, projects } = truth;
  const people = directoryPartiesOf(truth);
  const p = projects.find((x) => x.id === project);
  if (!p) {
    return null;
  }
  const ids = new Set([
    ...p.people,
    ...people.filter((x) => x.projects.includes(project)).map((x) => x.id),
  ]);
  return {
    chats: p.chats.flatMap((id) => {
      const c = chats.find((x) => x.id === id);
      return c
        ? [
            {
              isSure: !!c.whatsapp || !c.id.startsWith("!"),
              key: c.whatsapp ?? c.id,
              name: c.name,
            },
          ]
        : [];
    }),
    people: [...ids].flatMap((id) => {
      const x = people.find((y) => y.id === id);
      return x
        ? [
            {
              aliases: x.aliases,
              handles: Object.entries(x.handles).flatMap(([platform, v]) => {
                const values = ([] as string[]).concat(v ?? []);
                return values.length ? [{ platform, values }] : [];
              }),
              id: x.id,
              name: x.name,
            },
          ]
        : [];
    }),
  };
}

/** People and organizations share one id space and their handles: a clash is refused. Gives every party's id. */
function checkParties(truth: Truth, issues: string[]): Set<string> {
  const ids = new Set<string>();
  const owner = new Map<string, string>();
  for (const p of directoryPartiesOf(truth)) {
    if (ids.has(p.id)) {
      issues.push(`person ${p.id} is listed twice`);
    }
    ids.add(p.id);
    if (p.id.startsWith(INFERRED_PREFIX)) {
      issues.push(
        `person ${p.id}: "${INFERRED_PREFIX}" ids are Life's inferred people`
      );
    }
    if (p.id.startsWith(CONTACT_PREFIX)) {
      issues.push(
        `person ${p.id}: "${CONTACT_PREFIX}" ids are the people his Contacts name`
      );
    }
    for (const h of new Set(handlesOf(p))) {
      const other = owner.get(h);
      if (other && other !== p.id) {
        issues.push(`${h} belongs to both ${other} and ${p.id}`);
      }
      owner.set(h, p.id);
    }
  }
  if (!truth.people.some((p) => p.id === ME)) {
    issues.push(`people.yaml needs the owner as id "${ME}"`);
  }
  return ids;
}

/** An organization's people are people of his directory, and its projects exist. */
function checkOrganizations(
  { organizations, people }: Truth,
  projectIds: Set<string>,
  issues: string[]
) {
  const personIds = new Set(people.map((p) => p.id));
  for (const o of organizations) {
    for (const m of o.people.filter((x) => !personIds.has(x.id))) {
      issues.push(`organization ${o.id} names unknown person ${m.id}`);
    }
    for (const pr of o.projects.filter((id) => !projectIds.has(id))) {
      issues.push(`organization ${o.id} names unknown project ${pr}`);
    }
  }
}

function checkRepos(projects: Truth["projects"], issues: string[]) {
  const owner = new Map<string, string>();
  for (const p of projects) {
    for (const r of p.repos) {
      const other = owner.get(r);
      if (other && other !== p.id) {
        issues.push(`repo ${r} belongs to both ${other} and ${p.id}`);
      }
      owner.set(r, p.id);
    }
  }
}

/**
 * His goals, in his order: each one's words as he reads them (a bracket of only project ids left out, other ids as plain
 * words, on one line) and the project ids it names. The one parse of `## Goals`.
 */
export const goalsOf = (goals = "") =>
  goals
    .split(GOAL_START)
    .slice(1)
    .map((g) => ({
      projects: [...g.matchAll(PROJECT_ID)].map((m) => m[1] ?? ""),
      text: g
        .replace(ID_BRACKET, "")
        .replace(PROJECT_ID, "$1")
        .replace(SPACES, " ")
        .replace(SPACE_BEFORE_STOP, "$1")
        .trim(),
    }));

/** The project ids each of his goals names, in his order: what ranks an open item by the first goal it serves. */
export const goalProjects = (goals = "") =>
  goalsOf(goals).map((g) => g.projects);

function checkGoals(
  goals: string | undefined,
  projects: Set<string>,
  issues: string[]
) {
  for (const id of goalProjects(goals).flat()) {
    if (!projects.has(id)) {
      issues.push(`a goal in me.md names unknown project ${id}`);
    }
  }
}

/** Empty means the directory is consistent: every reference points at something that exists. */
export function integrity(truth: Truth): string[] {
  const { areas, people, chats, me, projects } = truth;
  const issues: string[] = [];
  const personIds = checkParties(truth, issues);
  const projectIds = new Set(projects.map((p) => p.id));
  checkOrganizations(truth, projectIds, issues);
  const chatIds = new Set<string>();
  for (const c of chats) {
    if (chatIds.has(c.id)) {
      issues.push(`chat ${c.id} is listed twice`);
    }
    chatIds.add(c.id);
  }
  // A chat's id may itself be a WhatsApp id: never the `whatsapp` of another chat (one chat, two entries).
  for (const c of chats.filter((x) =>
    chats.some((o) => o !== x && o.id === x.whatsapp)
  )) {
    issues.push(`chat ${c.id}'s whatsapp is another chat's id`);
  }
  const areaIds = new Set<string>();
  for (const a of areas) {
    if (areaIds.has(a.id)) {
      issues.push(`area ${a.id} is listed twice`);
    }
    areaIds.add(a.id);
  }
  checkRepos(projects, issues);
  for (const p of projects) {
    if (!areaIds.has(p.area)) {
      issues.push(`project ${p.id} names unknown area ${p.area}`);
    }
    for (const m of p.people.filter((id) => !personIds.has(id))) {
      issues.push(`project ${p.id} names unknown person ${m}`);
    }
    for (const c of p.chats.filter((id) => !chatIds.has(id))) {
      issues.push(`project ${p.id} names unknown chat ${c}`);
    }
  }
  for (const p of people) {
    for (const pr of p.projects.filter((id) => !projectIds.has(id))) {
      issues.push(`person ${p.id} names unknown project ${pr}`);
    }
  }
  checkGoals(me.goals, projectIds, issues);
  return issues;
}

/** A directory entry as written in its file, before the schema's defaults: what the directory's writer and its change reader compare. */
export interface Entry {
  aliases?: string[];
  domains?: string[];
  handles?: Record<string, unknown>;
  id: string;
  name?: string;
  people?: { id: string }[];
  projects?: string[];
}

/** A directory file's entries as written (no defaults); none when the text holds none. */
export const entriesOf = (text: string, key: string) =>
  (((text ? parse(text) : null) as Record<string, unknown[]> | null)?.[key] ??
    []) as Entry[];

/**
 * What of his directory was added or changed since `since`: each person's and organization's id, and each
 * organization's link to a person as `<organization>|<person>`, compared with the data repo's last commit before
 * `since` (every one when there is none). One `git log -1` and two `git show`s of one commit: the directory's size, never its history.
 */
export function readDirectoryChangesSince(
  since: string,
  data = OWNER_DATA_DIR
) {
  // The last commit before `since`, any file: none on a repo with no commit before it (every entry is then new).
  const before = gitOut(data, [
    "log",
    "-1",
    "--format=%H",
    `--before=${since}`,
  ]);
  /** A file at that commit; empty when the commit did not hold it. Any other failure throws. */
  const was = (file: string) =>
    before &&
    git(data, ["cat-file", "-e", `${before}:truth/${file}`]).exitCode === 0
      ? gitOut(data, ["show", `${before}:truth/${file}`])
      : "";
  const keyed = (entries: Entry[]) =>
    new Map(
      entries.flatMap((e) => [
        [e.id, JSON.stringify(e)] as const,
        ...(e.people ?? []).map(
          (l) => [`${e.id}|${l.id}`, JSON.stringify(l)] as const
        ),
      ])
    );
  const changed = new Set<string>();
  for (const [file, key] of [
    ["people.yaml", "people"],
    ["organizations.yaml", "organizations"],
  ] as const) {
    const path = join(data, "truth", file);
    const now = keyed(
      entriesOf(existsSync(path) ? readFileSync(path, "utf8") : "", key)
    );
    const then = keyed(entriesOf(was(file), key));
    for (const [k, v] of now) {
      if (then.get(k) !== v) {
        changed.add(k);
      }
    }
  }
  return changed;
}
