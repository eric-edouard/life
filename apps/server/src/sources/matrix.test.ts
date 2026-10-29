import { expect, test } from "bun:test";
import { blockOf, bridgeSend } from "./matrix";

test("a bridge that isn't set up or running is a reason the send is blocked, never a throw", async () => {
  expect(await bridgeSend("nowhere").blocked()).toContain(
    "nowhere bridge not answering"
  );
});

test("a bridge blocks sends only when never linked or in a state it won't leave by itself", () => {
  expect(blockOf("whatsapp", [])).toContain("not linked");
  expect(
    blockOf("whatsapp", [{ state: { state_event: "CONNECTED" } }])
  ).toBeUndefined();
  expect(
    blockOf("whatsapp", [{ state: { state_event: "TRANSIENT_DISCONNECT" } }])
  ).toBeUndefined();
  expect(
    blockOf("whatsapp", [
      {
        state: {
          message: "logged out on the phone",
          state_event: "BAD_CREDENTIALS",
        },
      },
    ])
  ).toBe("whatsapp bridge BAD_CREDENTIALS: logged out on the phone");
});
