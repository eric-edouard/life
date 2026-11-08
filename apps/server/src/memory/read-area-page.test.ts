import { expect, test } from "bun:test";
import { areaFor } from "./read-area-page";

test("area: an area's or a project's id or name, never a part of one", () => {
  const truth = {
    areas: [{ id: "construction", name: "Construction" }],
    projects: [{ area: "construction", id: "house", name: "The House" }],
  } as unknown as Parameters<typeof areaFor>[1];
  expect(areaFor("construction", truth)).toEqual({
    id: "construction",
    project: undefined,
  });
  expect(areaFor("CONSTRUCTION", truth).id).toBe("construction");
  expect(areaFor("house", truth).project?.id).toBe("house");
  expect(areaFor("the house", truth).id).toBe("construction");
  expect(areaFor("constr", truth).id).toBeUndefined();
});
