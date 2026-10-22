import { expect, test } from "bun:test";
import { tunnelDown } from "./tunnel";

test("only Cloudflare's 530 is the tunnel; no answer, a dead app's 502 or any other answer is not", () => {
  expect(tunnelDown(530)).toBe(true);
  expect([0, 200, 401, 404, 502, 520, 524].map(tunnelDown)).toEqual(
    new Array(7).fill(false)
  );
});
