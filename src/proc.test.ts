import { expect, test } from "bun:test";
import { firstLine } from "./proc";

test("firstLine: stdin stays open until a whole line passes, then the server is killed; an exit is none", async () => {
  // Answers only after its input, in two writes: a half line must not pass.
  const server = [
    "sh",
    "-c",
    'read x; echo noise; printf "got "; sleep 0.1; echo "$x"; sleep 30',
  ];
  const started = performance.now();
  expect(await firstLine(server, "hello\n", (l) => l.startsWith("got"))).toBe(
    "got hello"
  );
  expect(performance.now() - started).toBeLessThan(5000);
  expect(
    await firstLine(["sh", "-c", "echo noise"], "", (l) => l === "x")
  ).toBeUndefined();
});
