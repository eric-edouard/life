import { expect, test } from "bun:test";
import { NETWORKS } from "./networks";

test("every network says how it signs in from the phone: its bridge's login flow", () => {
  for (const n of NETWORKS) {
    expect(n.loginFlow.trim()).not.toBe("");
  }
  expect(new Set(NETWORKS.map((n) => n.name)).size).toBe(NETWORKS.length);
});
