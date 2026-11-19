import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { OWNER_DATA_DIR } from "../core/paths";
import { CONTACT_PREFIX, INFERRED_PREFIX } from "../records/observation";
import {
  type Area,
  AreasFile,
  type Chat,
  ChatsFile,
  ME,
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
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export interface Truth {
  areas: Area[];
  chats: Chat[];
  /** truth/me.md, read once: all of it, its first paragraph, his goals and what Life may keep (none: no limit). */
  me: { about?: string; goals?: string; mayKeep?: string; text: string };
  people: Person[];
  projects: (Project & { notes: string })[];
}

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
  return Bun.YAML.parse(await Bun.file(path).text());
}

function frontmatter(text: string, path: string) {
  const [, head, body] = text.match(FRONTMATTER) ?? [];
  if (head === undefined) {
    throw new Error(`${path}: missing --- frontmatter ---`);
  }
  return { body: (body ?? "").trim(), data: Bun.YAML.parse(head) };
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
  const { whatsapp, phone, email, github, lifelog, telegram } = p.handles;
  return [
    ...whatsapp,
    ...phone,
    ...email.map((h) => h.toLowerCase()),
    ...(github ? [github.toLowerCase()] : []),
    ...(lifelog ? [lifelog] : []),
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
  { chats, people, projects }: Pick<Truth, "chats" | "people" | "projects">,
  project: string
) {
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

/** Empty means the directory is consistent: every reference points at something that exists. */
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
