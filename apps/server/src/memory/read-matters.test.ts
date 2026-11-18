import { expect, spyOn, test } from "bun:test";
import { oneMatter, openMatters } from "./read-matters";

test("read_matters lists the open matters, of one project when asked; read_matter opens one with its steps", async () => {
  const who = await import("./who");
  const matters = await import("./matters");
  const items = await import("./read-open-items");
  const rank = spyOn(items, "rankContextOf").mockReturnValue({
    goals: [],
    levels: new Map(),
  });
  const step = (kind: string, text: string, day: string, ref: string) => ({
    at: `${day}T10:00:00.000Z`,
    day,
    kind,
    quote: `"${text}" said Gran`,
    ref,
    text,
  });
  const view = (over: object) => ({
    areas: [],
    lone: false,
    open: true,
    openSteps: [],
    owedTo: [],
    projects: [],
    told: [],
    waitingOn: [],
    with: [],
    ...over,
  });
  const steps = [
    step("episode", "Gran's watch", "2026-10-02", "ep_000000000001"),
    step("promise", "Call the shop", "2026-10-12", "obs_000000000005"),
  ];
  const errand = view({
    goal: {
      at: "2026-10-13T02:00:00.000Z",
      by: "life",
      text: "Gran has her watch back",
    },
    id: "matter_aaaaaaaaaaaa",
    name: "Mend Gran's watch",
    newestOpenStep: steps[1],
    nextStep: {
      at: "2026-10-13T09:00:00.000Z",
      by: "owner",
      kind: "wait_event",
      text: "The shop's quote",
      waitsOn: "the shop",
    },
    owedTo: ["person:gran"],
    projects: ["shop-fit-out"],
    status: "moving",
    steps,
    with: ["person:partner"],
  });
  const other = view({
    id: "matter_bbbbbbbbbbbb",
    name: "Renew the lease",
    newestOpenStep: step(
      "waiting_on_someone",
      "Landlord's reply",
      "2026-10-01",
      "obs_000000000009"
    ),
    status: "waiting_on_someone",
    steps: [],
    waitingOn: ["person:shop"],
  });
  const people = spyOn(who, "readPeople").mockResolvedValue({
    nameOf: (r: string) => r.replace("person:", ""),
    truth: {
      areas: [],
      projects: [{ id: "shop-fit-out", name: "Shop fit-out" }],
    },
  } as never);
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    other,
    errand,
    {
      ...view({ id: "matter_cccccccccccc", name: "Old", steps: [] }),
      open: false,
      status: "done",
    },
  ] as never);
  try {
    const all = (await openMatters({})).matters;
    // Ranked, not newest first: a promise owed comes before a wait, though the wait is older; a done one is not running.
    expect(all.map((m) => m.id)).toEqual([
      "matter_aaaaaaaaaaaa",
      "matter_bbbbbbbbbbbb",
    ]);
    const row = {
      goal: { by: "life", text: "Gran has her watch back" },
      id: "matter_aaaaaaaaaaaa",
      lastStepAt: "2026-10-12T10:00:00.000Z",
      name: "Mend Gran's watch",
      newestOpenStep: { day: "2026-10-12", text: "Call the shop" },
      nextStep: {
        by: "owner",
        kind: "wait_event",
        text: "The shop's quote",
        waitsOn: "the shop",
      },
      people: {
        owedTo: ["gran"],
        with: ["partner"],
      },
      projects: ["shop-fit-out"],
      status: "moving",
    };
    // Empty fields are left out of the JSON a model reads.
    expect(JSON.parse(JSON.stringify(all[0]))).toEqual(row);
    expect(all[1]?.people?.waitingOn).toEqual(["shop"]);
    expect(
      (await openMatters({ project: "Shop fit-out" })).matters.map((m) => m.id)
    ).toEqual(["matter_aaaaaaaaaaaa"]);
    expect(openMatters({ project: "Nowhere" })).rejects.toThrow(
      "No project goes by that name."
    );
    const one = await oneMatter(["matter_aaaaaaaaaaaa"]);
    expect(JSON.parse(JSON.stringify(one))).toEqual({
      ...row,
      agents: [],
      steps,
    });
    // A step's id opens the matter holding it; anchors find it by the first that still names a step.
    expect(await oneMatter(["obs_000000000005"])).toEqual(one);
    expect(await oneMatter(["obs_gone", "obs_000000000005"])).toEqual(one);
    expect(await oneMatter(["matter_zzzzzzzzzzzz"])).toBeUndefined();
    // Host's agents on it and its active agent, given the matter's steps.
    expect(
      (
        await oneMatter(["matter_aaaaaaaaaaaa"], (refs) =>
          refs.includes("obs_000000000005") ? [{ id: "agt_000000000001" }] : []
        )
      )?.agents
    ).toEqual([{ id: "agt_000000000001" }]);
    expect(
      (
        await openMatters({}, (refs) =>
          refs.includes("ep_000000000001") ? "agt_000000000001" : undefined
        )
      ).matters[0]?.agent
    ).toBe("agt_000000000001");
  } finally {
    people.mockRestore();
    book.mockRestore();
    rank.mockRestore();
  }
});
