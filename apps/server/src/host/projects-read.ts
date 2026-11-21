import { join } from "node:path";
import { HOME } from "../core/platform";
import { blockingCountOf } from "../memory/check-urgency";
import { checksOnMatterOf } from "../memory/checks";
import { nextStepNow } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { readProjectSituationNow } from "../memory/project-situation-read";
import {
  isInScope,
  needsYouOf,
  openDecisions,
  projectStepRefsOf,
  rankedRunning,
} from "../memory/read-matters";
import { goalsOf, projectPeopleAndChatsOf } from "../memory/read-truth";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { openChecksAndKeyNow, unchangedOf, versionOf } from "./inbox";
import { readRegisteredAgents } from "./registered-agents";

// `read_projects` and `read_project` (life#712): the Projects tab's chip row and a project chip's header with its
// Details. The list under a chip is `read_matters` (`project`, or `area` with `noProject`); a chip's counts and that list
// come from one rule, `isInScope`. Read once per checks' key (it covers the matter book, the cards, what agents hold
// and the project situations), as `read_matters` is.

/** A project's alive agents (running, or waiting on something), as the desk reads them now. */
const aliveAgentsOf = async (
  book: Awaited<ReturnType<typeof readMatterBook>>,
  people: Awaited<ReturnType<typeof readPeople>>
) =>
  (
    await readRegisteredAgents(undefined, {
      book,
      decisions: openDecisions(),
      people,
    })
  ).agents.filter((a) => a.status === "running" || a.status === "waiting");

/** The ids of the matters a chip holds, from the matters the agents are on: a project's agent or an agent on one of its matters. */
const isOnChip =
  (project: string | undefined, matterIds: ReadonlySet<string>) =>
  (a: { matter: { id: string } | null; project: string | null }) =>
    (project !== undefined && a.project === project) ||
    (a.matter !== null && matterIds.has(a.matter.id));

async function readChips() {
  const [{ checks: open }, people] = await Promise.all([
    openChecksAndKeyNow(),
    readPeople(),
  ]);
  const { truth } = people;
  const { book, decisions, ranked } = await rankedRunning(
    {},
    async (p, t) => ({ book: await readMatterBook(p, t) }),
    people
  );
  const agents = await aliveAgentsOf(book, people);
  const needs = new Set(
    ranked
      .filter((v) =>
        needsYouOf(
          { nextStep: nextStepNow(v, decisions), status: v.status },
          blockingCountOf(checksOnMatterOf(open, v.id))
        )
      )
      .map((v) => v.id)
  );
  const chipOf = (
    c: { id: string; name: string } & (
      | { kind: "area" }
      | { area: string; kind: "project"; status: string }
    ),
    scope: Parameters<typeof isInScope>[1]
  ) => {
    const matters = ranked.filter(isInScope(truth, scope));
    const ids = new Set(matters.map((v) => v.id));
    const isParked = c.kind === "project" && c.status === "parked";
    return {
      ...c,
      agentAtWork:
        !isParked &&
        agents.some(
          (a) =>
            a.status === "running" &&
            isOnChip(c.kind === "project" ? c.id : undefined, ids)(a)
        ),
      matters: matters.length,
      needYou: matters.filter((v) => needs.has(v.id)).length,
    };
  };
  const goalRank = (id: string) => {
    const i = goalsOf(truth.me.goals).findIndex((g) => g.projects.includes(id));
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  const projectChips = (isIn: (s: string) => boolean) =>
    truth.projects
      .filter((p) => isIn(p.status))
      .map((p) =>
        chipOf(
          {
            area: p.area,
            id: p.id,
            kind: "project",
            name: p.name,
            status: p.status,
          },
          { project: p.id }
        )
      );
  const underway = projectChips((s) => s === "active" || s === "waiting");
  const answer = {
    all: { needYou: needs.size, open: ranked.length },
    chips: [
      // Those needing him first, then by his goals, the directory's order for a tie (a stable sort).
      ...underway.toSorted(
        (a, b) =>
          Number(b.needYou > 0) - Number(a.needYou > 0) ||
          goalRank(a.id) - goalRank(b.id)
      ),
      ...truth.areas
        .map((a) =>
          chipOf(
            { id: a.id, kind: "area", name: a.name },
            { area: a.id, noProject: true }
          )
        )
        .filter((c) => c.matters > 0),
      ...projectChips((s) => s === "parked"),
    ],
  };
  return { ...answer, version: versionOf(JSON.stringify(answer)) };
}

async function readHeader(name: string) {
  const [{ checks: open }, people] = await Promise.all([
    openChecksAndKeyNow(),
    readPeople(),
  ]);
  const { truth } = people;
  const project = truth.projects.find(
    (p) => p.id === name || p.name.toLowerCase() === name.toLowerCase()
  );
  if (!project) {
    throw new Error(`No project goes by ${name}.`);
  }
  const book = await readMatterBook(people, dayNow());
  const own = book.filter((v) => v.projects.includes(project.id));
  const ids = new Set(own.filter((v) => v.open).map((v) => v.id));
  const goals = goalsOf(truth.me.goals);
  const rank = goals.findIndex((g) => g.projects.includes(project.id));
  const entry = projectPeopleAndChatsOf(truth, project.id);
  // The most pressing open decision about one of its matters, in the inbox's own order.
  const ask = open.find(
    (c) =>
      c.kind === "decision" &&
      ((c.matter !== null && ids.has(c.matter.id)) ||
        c.ridesOn.matterIds.some((i) => ids.has(i)))
  );
  const agents =
    project.status === "parked" || project.status === "done"
      ? []
      : (await aliveAgentsOf(book, people)).filter(isOnChip(project.id, ids));
  const answer = {
    project: {
      agents: agents.map((a) => ({
        id: a.id,
        line: a.wait ? `Waiting for ${a.wait.reason}` : a.notes || a.title,
        status: a.status,
        title: a.title,
      })),
      ask: ask && {
        deadline: ask.deadline,
        matter: ask.matter ?? ask.onMatters[0] ?? null,
        question: ask.question,
        ref: ask.ref,
      },
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
      repos: project.repos.map((r) => ({
        folder: r.includes("/") ? null : join(HOME, "Work", r),
        name: r,
      })),
      situation: readProjectSituationNow(
        project.id,
        projectStepRefsOf(truth, book, project.id)
      ),
      status: project.status,
    },
  };
  return { ...answer, version: versionOf(JSON.stringify(answer)) };
}

/** One answer per key of the checks (the matter book's files, the cards, what agents hold, the situations) and call. */
let kept: { for: string; reads: Map<string, Promise<unknown>> } | undefined;
async function keptRead<A extends { version: string }>(
  rest: string,
  read: () => Promise<A>,
  ifNot?: string
) {
  const { key } = await openChecksAndKeyNow();
  const keptFor = JSON.stringify([key, dayNow()]);
  if (kept?.for !== keptFor) {
    kept = { for: keptFor, reads: new Map() };
  }
  let answer = kept.reads.get(rest) as Promise<A> | undefined;
  if (!answer) {
    answer = read();
    kept.reads.set(rest, answer);
    answer.catch(() => kept?.reads.delete(rest));
  }
  const a = await answer;
  return a.version === ifNot ? unchangedOf(ifNot) : a;
}

/** `read_projects`: the chip row. */
export const readProjectsNow = (ifNot?: string) =>
  keptRead("chips", readChips, ifNot);

/** `read_project`: one project's header and Details. */
export const readProjectNow = (project: string, ifNot?: string) =>
  keptRead(`project ${project}`, () => readHeader(project), ifNot);
