import { expect, test } from "bun:test";
import { rpc, token } from "./mcp-test-harness";

// The People tab's pictures.

const GRAN_PICTURE = "00000000000000000000000000000a02";

test("people's pictures go to any app he paired, never to a paired agent", async () => {
  const { json } = await rpc(await token(), "tools/call", {
    arguments: { ids: [GRAN_PICTURE] },
    name: "read_person_pictures",
  });
  expect(json.result.isError).toBe(true);
  expect(json.result.content[0].text).toContain("paired as an agent");
});
