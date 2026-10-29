import { expect, test } from "bun:test";
import { bridgeSend } from "./matrix";

test("a bridge that isn't set up or running is a reason the send is blocked, never a throw", async () => {
  expect(await bridgeSend("nowhere").blocked()).toContain(
    "nowhere bridge not answering"
  );
});
