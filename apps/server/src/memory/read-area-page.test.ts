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

test("area: a project named in another script is found by its name, and no other word finds it", () => {
  const truth = {
    areas: [{ id: "home", name: "Дом" }],
    projects: [{ area: "home", id: "wall", name: "王的墙" }],
  } as unknown as Parameters<typeof areaFor>[1];
  expect(areaFor("王的墙", truth).project?.id).toBe("wall");
  expect(areaFor("дом", truth).id).toBe("home");
  expect(areaFor("แม่", truth).id).toBeUndefined();
});
