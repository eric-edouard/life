import { expect, test } from "bun:test";
import { NETWORKS } from "@life/server/src/sources/networks";
import { bundledNotice } from "./bundled-tools";

test("every network's bridge has a pinned tag and a line in the notice", () => {
  for (const n of NETWORKS) {
    expect(n.tag).toBeTruthy();
    expect(bundledNotice()).toContain(`${n.label} bridge`);
  }
});
