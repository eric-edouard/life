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
    id: "matter_aaaaaaaaaaaa",
    name: "Mend Gran's watch",
    next: steps[1],
    owedTo: ["person:gran"],
    projects: ["shop-fit-out"],
    status: "moving",
    steps,
    with: ["person:partner"],
  });
  const other = view({
    id: "matter_bbbbbbbbbbbb",
    name: "Renew the lease",
    next: step(
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
    const all = await openMatters({});
    expect(all).toContain(
      "- matter_aaaaaaaaaaaa Mend Gran's watch [moving]; owed to gran; next: Call the shop (2026-10-12)"
    );
    expect(all).toContain("waiting on shop");
    expect(all).not.toContain("Old");
    // Ranked, not newest first: a promise owed comes before a wait, though the wait is older.
    expect(all.indexOf("matter_aaaaaaaaaaaa")).toBeLessThan(
      all.indexOf("matter_bbbbbbbbbbbb")
    );
    const ofProject = await openMatters({ project: "Shop fit-out" });
    expect(ofProject).toContain("matter_aaaaaaaaaaaa");
    expect(ofProject).not.toContain("matter_bbbbbbbbbbbb");
    const read = oneMatter;
    const one = (await read("matter_aaaaaaaaaaaa")).split("\n");
    expect(one.slice(0, 4)).toEqual([
      "matter_aaaaaaaaaaaa Mend Gran's watch [moving]",
      "owed to: gran",
      "with: partner",
      "Projects: shop-fit-out",
    ]);
    expect(one).toContain(
      '- 2026-10-12 promise obs_000000000005: Call the shop ""Call the shop" said Gran"'
    );
    // A step's id opens the matter holding it.
    expect(await read("obs_000000000005")).toBe(one.join("\n"));
    expect(await read("matter_zzzzzzzzzzzz")).toBe(
      "No matter matter_zzzzzzzzzzzz."
    );
    // Host's Agents part and mark, given the matter's steps.
    const withAgents = await oneMatter("matter_aaaaaaaaaaaa", (refs) =>
      refs.includes("obs_000000000005") ? ["- agt_000000000001 [waiting]"] : []
    );
    expect(withAgents).toEndWith("\nAgents:\n- agt_000000000001 [waiting]");
    expect(
      await openMatters({}, (refs) =>
        refs.includes("ep_000000000001") ? "agent agt_000000000001" : ""
      )
    ).toContain("(2026-10-12); agent agt_000000000001");
  } finally {
    people.mockRestore();
    book.mockRestore();
    rank.mockRestore();
  }
});
