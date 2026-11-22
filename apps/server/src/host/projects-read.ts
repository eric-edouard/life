import { nextStepNow } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { readProjectSituationNow } from "../memory/project-situation-read";
import {
  isInScope,
  namedIdOf,
  openDecisions,
  projectStepRefsOf,
  rankedMatters,
} from "../memory/read-matters";
import { goalsOf, projectPeopleAndChatsOf } from "../memory/read-truth";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { isUnderway } from "../records/truth";
import { listRepos } from "../sources/git";
import { openChecksAndKeyNow, unchangedOf, versionOf } from "./inbox";
import { matterRowsNowOf } from "./matter-rows";
import { readActiveAgentOf, readAgentsOnSteps } from "./registered-agents";

// `read_projects` and `read_project` (life#712): the Projects tab's chip row and a project chip's header with its
// Details. The list under a chip is `read_matters` (`project`, or `area` with `noProject`); a chip's counts and that list
// come from one rule, `isInScope`. What comes from memory is read once per checks' key (the matter book, the cards, the
// project situations); a project's header joins who is at work (the desk), read on every call, before its version is made,
// so an agent's turn that ends moves it.

type Open = Awaited<ReturnType<typeof openChecksAndKeyNow>>["checks"];

async function readChipsFromMemory(open: Open) {
  const people = await readPeople();
  const { truth } = people;
  const { decisions, ranked } = await rankedMatters(
    {},
    async (p, t) => ({ book: await readMatterBook(p, t) }),
    people
  );
  const needs = new Set(
    matterRowsNowOf(
      ranked.map((v) => ({
        id: v.id,
        nextStep: nextStepNow(v, decisions),
        status: v.status,
      })),
      open
    )
      .filter((r) => r.needsYou)
      .map((r) => r.id)
  );
  const chipOf = <C extends { id: string; kind: "area" | "project" }>(
    c: C,
    scope: Parameters<typeof isInScope>[1]
  ) => {
    const held = ranked.filter(isInScope(truth, scope));
    return {
      ...c,
      matters: held.length,
      needYou: held.filter((v) => needs.has(v.id)).length,
    };
  };
  const goalRank = (id: string) => {
    const i = goalsOf(truth.me.goals).findIndex((g) => g.projects.includes(id));
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  const groupOf = (p: (typeof truth.projects)[number]) => {
    if (isUnderway(p)) {
      return "underway";
    }
    return p.status === "done" ? "done" : "parked";
  };
  const projectChips = (group: ReturnType<typeof groupOf>) =>
    truth.projects
      .filter((p) => groupOf(p) === group)
      .map((p) =>
        chipOf(
          {
            area: p.area,
            id: p.id,
            kind: "project" as const,
            name: p.name,
            status: p.status,
          },
          { project: p.id }
        )
      );
  return {
    all: { needYou: needs.size, open: ranked.length },
    chips: [
      // Those needing him first, then by his goals, the directory's order for a tie (a stable sort).
      ...projectChips("underway").toSorted(
        (a, b) =>
          Number(b.needYou > 0) - Number(a.needYou > 0) ||
          goalRank(a.id) - goalRank(b.id)
      ),
      ...truth.areas
        .map((a) =>
          chipOf(
            { id: a.id, kind: "area" as const, name: a.name },
            { area: a.id, noProject: true }
          )
        )
        .filter((c) => c.matters > 0),
      // A done project is never lost: after the parked ones.
      ...projectChips("parked"),
      ...projectChips("done"),
    ],
  };
}

/** The chip row, all from memory. */
function finishChips(answer: Awaited<ReturnType<typeof readChipsFromMemory>>) {
  return { ...answer, version: versionOf(JSON.stringify(answer)) };
}

async function readHeaderFromMemory(name: string, open: Open) {
  const people = await readPeople();
  const { truth } = people;
  const id = namedIdOf(truth.projects, name);
  const project = truth.projects.find((p) => p.id === id);
  if (!project) {
    throw new Error(`No project goes by ${name}.`);
  }
  const book = await readMatterBook(people, dayNow());
  const own = book.filter((v) => v.open && v.projects.includes(project.id));
  const goals = goalsOf(truth.me.goals);
  const rank = goals.findIndex((g) => g.projects.includes(project.id));
  const entry = projectPeopleAndChatsOf(truth, project.id);
  // The most pressing open decision about one of its matters, in the inbox's own order, with the matter it is about.
  const [asked] = open.flatMap((c) => {
    const matter = [c.matter?.id, ...c.ridesOn.matterIds]
      .map((i) => own.find((v) => v.id === i))
      .find(Boolean);
    return c.kind === "decision" && matter ? [{ c, matter }] : [];
  });
  return {
    book,
    decisions: openDecisions(),
    own,
    people,
    project,
    shown: {
      ask: asked
        ? {
            deadline: asked.c.deadline,
            matter: {
              id: asked.matter.id,
              ...(asked.matter.important ? { important: true } : {}),
              name: asked.matter.name,
            },
            question: asked.c.question,
            ref: asked.c.ref,
          }
        : null,
      chats: (entry?.chats ?? []).map(({ key, name: n }) => ({ key, name: n })),
      goal:
        rank < 0
          ? null
          : { of: goals.length, rank: rank + 1, text: goals[rank]?.text },
      id: project.id,
      name: project.name,
      people: (entry?.people ?? []).map((x) =>
        people.partyOf(`person:${x.id}`)
      ),
      situation: readProjectSituationNow(
        project.id,
        projectStepRefsOf(truth, book, project.id)
      ),
      status: project.status,
    },
  };
}

/** One project's header: memory's part kept per key, its agents at work read now (none while it is not underway). */
function finishHeader(m: Awaited<ReturnType<typeof readHeaderFromMemory>>) {
  const holder = readActiveAgentOf();
  const held = new Set(
    m.own.flatMap((v) => holder(v.steps.map((s) => s.ref)) ?? [])
  );
  // Each agent as its assignment on the project's steps reads (an open one first), those holding one of them open now.
  const agents = isUnderway(m.project)
    ? readAgentsOnSteps(
        m.own.flatMap((v) => v.steps.map((s) => s.ref)),
        m.people
      )
        .filter(
          (a) =>
            held.has(a.id) && (a.status === "running" || a.status === "waiting")
        )
        .map((a) => ({
          id: a.id,
          // Its turn says which: a waiting agent says what for; one at work, what it took its subject to be.
          line:
            a.status === "waiting" && a.wait
              ? `Waiting for ${a.wait.reason}`
              : a.notes || a.title,
          status: a.status,
          title: a.title,
        }))
    : [];
  // A repo's folder is where it is cloned on the Mac now (`listRepos`), none for one that is not.
  const here = new Map(listRepos().map((r) => [r.key, r.path]));
  const answer = {
    project: {
      ...m.shown,
      agents,
      repos: m.project.repos.map((r) => ({
        folder: here.get(r) ?? null,
        name: r,
      })),
    },
  };
  return { ...answer, version: versionOf(JSON.stringify(answer)) };
}

/** What memory gives, once per key of the checks (the matter book's files, the cards, the situations) and call; its promise leaves the cache only if it fails. */
let kept: { for: string; reads: Map<string, Promise<unknown>> } | undefined;
async function keptRead<M, A extends { version: string }>(
  rest: string,
  read: (open: Open) => Promise<M>,
  finish: (m: M) => A | Promise<A>,
  ifNot?: string
) {
  const { checks, key } = await openChecksAndKeyNow();
  const keptFor = JSON.stringify([key, dayNow()]);
  if (kept?.for !== keptFor) {
    kept = { for: keptFor, reads: new Map() };
  }
  const { reads } = kept;
  let memory = reads.get(rest) as Promise<M> | undefined;
  if (!memory) {
    const own = read(checks);
    memory = own;
    reads.set(rest, own);
    own.catch(() => {
      if (reads.get(rest) === own) {
        reads.delete(rest);
      }
    });
  }
  const a = await finish(await memory);
  return a.version === ifNot ? unchangedOf(ifNot) : a;
}

/** `read_projects`: the chip row. */
export const readProjectsNow = (ifNot?: string) =>
  keptRead("chips", readChipsFromMemory, finishChips, ifNot);

/** `read_project`: one project's header and Details. */
export const readProjectNow = (project: string, ifNot?: string) =>
  keptRead(
    `project ${project}`,
    (open) => readHeaderFromMemory(project, open),
    finishHeader,
    ifNot
  );
