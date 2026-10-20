import { expect, test } from "bun:test";
import { tunnelDown } from "./tunnel";

test("only Cloudflare's 530 or no answer is the tunnel; a dead app's 502 or any other answer is not", () => {
  expect([530, 0].map(tunnelDown)).toEqual([true, true]);
  expect([200, 401, 404, 502, 520, 524].map(tunnelDown)).toEqual(
    new Array(6).fill(false)
  );
});
