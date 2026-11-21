import { expect, test } from "bun:test";
import { roleLineOf } from "./migrate";

test("a desk ask's `personal` flag becomes its role; false is dropped; every other line is kept byte for byte", () => {
  const line = (agentChange: object) =>
    JSON.stringify({ after: { agent: "desk", agentChange }, id: "a1" });
  expect(
    roleLineOf(line({ action: "start", name: "Test", personal: true }))
  ).toBe(line({ action: "start", name: "Test", role: "personal" }));
  expect(roleLineOf(line({ action: "start", personal: false }))).toBe(
    line({ action: "start" })
  );
  const other = '{ "id": "a2", "said": "personal" }';
  expect(roleLineOf(other)).toBe(other);
  expect(roleLineOf("")).toBe("");
});
