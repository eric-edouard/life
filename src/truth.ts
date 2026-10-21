import { cpSync, existsSync, mkdtempSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Area,
  AreasFile,
  type Chat,
  ChatsFile,
  INFERRED_PREFIX,
  PeopleFile,
  type Person,
  Project,
} from "./schema";

export const ROOT = join(import.meta.dir, "..");
/** `bun test` sets NODE_ENV=test: tests never touch the real log or data. */
export const TEST = process.env.NODE_ENV === "test";
/** The made-up data tests read (src/test-data). */
export const FIXTURES = join(ROOT, "src", "test-data");
/**
 * His data: a local git repo of its own (memory/ and truth/), never pushed. A test run reads its own copy of the
 * made-up data, outside any repo: two runs at once (a push's check beside another session's tests) share no lock or
 * ledger, and none can commit.
 */
export const DATA = TEST
  ? copied(FIXTURES)
  : (process.env.LIFE_DATA ?? join(homedir(), "Life"));

/**
 * Life's own state, never his: its settings, log, the watcher's store, the runs and the search index. A checkout keeps
 * it in its own derived/ (each worktree apart from production); the app sets `LIFE_STATE`. A test run keeps it in its
 * copy of the data.
 */
export const STATE = TEST
  ? join(DATA, "state")
  : (process.env.LIFE_STATE ?? join(ROOT, "derived"));

/** Is `data` his own ~/Life (not a copy)? What only a copy may take (`LIFE_LLM`, `LIFE_NOW`) asks this. */
export function isHis(data = DATA) {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  return real(data) === real(join(homedir(), "Life"));
}

// ponytail: each run leaves its ~24 KB copy for the OS to clear (an exit hook doesn't fire under bun test); delete
// old ones here if the temp folder ever matters.
function copied(from: string) {
  const to = mkdtempSync(join(tmpdir(), "life-test-"));
  cpSync(from, to, { recursive: true });
  return to;
}
const ME = "me";
/** The owner's own entry in truth/people.yaml. */
export function ownerIn(people: Person[]): Person {
  const me = people.find((p) => p.id === ME);
  if (!me) {
    throw new Error(`truth/people.yaml has no "${ME}"`);
  }
  return me;
}
/** The owner as an entity ref: the center of his memory. */
export const OWNER = `person:${ME}`;
/** The people other than the owner among an observation's entity refs. */
export const othersIn = (entities: string[]) =>
  entities.filter((e) => e.startsWith("person:") && e !== OWNER);
/** The first paragraph of truth/me.md. */
const ABOUT = /^# Me\n\n(.+(?:\n.+)*)/;
/** truth/me.md's goals: the block under `## Goals`, his words in his priority order. */
const GOALS = /(?:^|\n)## Goals\n([\s\S]*?)(?=\n## |$)/;
/** The projects a goal serves: the ids in backticks it names. */
const PROJECT_ID = /`([a-z0-9-]+)`/g;
/** Where a numbered goal starts. */
const GOAL_START = /^\d+\.\s/m;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export interface Truth {
  areas: Area[];
  chats: Chat[];
  /** truth/me.md, read once: all of it, its first paragraph and his goals. */
  me: { about?: string; goals?: string; text: string };
  people: Person[];
  projects: (Project & { notes: string })[];
}

export const readMe = (text: string): Truth["me"] => ({
  about: text.match(ABOUT)?.[1]?.replaceAll("\n", " "),
  goals: text.match(GOALS)?.[1]?.trim(),
  text,
});

async function yaml(path: string): Promise<unknown> {
  return Bun.YAML.parse(await Bun.file(path).text());
}

function frontmatter(text: string, path: string) {
  const [, head, body] = text.match(FRONTMATTER) ?? [];
  if (head === undefined) {
    throw new Error(`${path}: missing --- frontmatter ---`);
  }
  return { body: (body ?? "").trim(), data: Bun.YAML.parse(head) };
}

/** truth/me.md, read fresh. */
export const loadMe = async (data = DATA) =>
  readMe(await Bun.file(join(data, "truth", "me.md")).text());

export async function loadTruth(data = DATA): Promise<Truth> {
  const dir = join(data, "truth");
  const { people } = PeopleFile.parse(await yaml(join(dir, "people.yaml")));
  const { chats } = ChatsFile.parse(await yaml(join(dir, "chats.yaml")));
  const { areas } = AreasFile.parse(await yaml(join(dir, "areas.yaml")));
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
  return { areas, chats, me: await loadMe(data), people, projects };
}

/** Every handle a person has, normalized the way senders are looked up: emails lower-cased. */
export function handlesOf(p: Person): string[] {
  const { whatsapp, phone, email, lifelog, telegram } = p.handles;
  return [
    ...whatsapp,
    ...phone,
    ...email.map((h) => h.toLowerCase()),
    ...(lifelog ? [lifelog] : []),
    ...(telegram ? [telegram] : []),
  ];
}

function checkPeople(people: Person[], issues: string[]): Set<string> {
  const ids = new Set<string>();
  const owner = new Map<string, string>();
  for (const p of people) {
    if (ids.has(p.id)) {
      issues.push(`person ${p.id} is listed twice`);
    }
    ids.add(p.id);
    if (p.id.startsWith(INFERRED_PREFIX)) {
      issues.push(
        `person ${p.id}: "${INFERRED_PREFIX}" ids are Life's inferred people`
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
  if (!ids.has(ME)) {
    issues.push(`people.yaml needs the owner as id "${ME}"`);
  }
  return ids;
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

/** The project ids each of his goals names, in his order: what ranks an open item by the first goal it serves. */
export const goalProjects = (goals = "") =>
  goals
    .split(GOAL_START)
    .slice(1)
    .map((g) => [...g.matchAll(PROJECT_ID)].map((m) => m[1] ?? ""));

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

/** Empty means the map is consistent: every reference points at something that exists. */
export function integrity({
  areas,
  people,
  chats,
  me,
  projects,
}: Truth): string[] {
  const issues: string[] = [];
  const personIds = checkPeople(people, issues);
  const projectIds = new Set(projects.map((p) => p.id));
  const chatIds = new Set<string>();
  for (const c of chats) {
    if (chatIds.has(c.id)) {
      issues.push(`chat ${c.id} is listed twice`);
    }
    chatIds.add(c.id);
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
