import { expect, test } from "bun:test";
import { answerTo } from "./page";

test("the bench's page answers this Mac's own page only", async () => {
  let scored = 0;
  const answer = answerTo("/nowhere", "/nowhere/answers.jsonl", () => {
    scored += 1;
    return Promise.resolve();
  });
  const post = (url: string, origin: string) =>
    answer(new Request(url, { headers: { origin }, method: "POST" }));
  const own = "http://127.0.0.1:4000";
  // A name pointed at this Mac reads nothing, a page of another site writes nothing.
  expect(
    (await answer(new Request("http://evil.test:4000/report.json"))).status
  ).toBe(403);
  expect((await post(`${own}/score`, "http://evil.test")).status).toBe(405);
  expect(scored).toBe(0);
  expect((await post(`${own}/score`, own)).status).toBe(200);
  expect(scored).toBe(1);
  expect((await post(`${own}/answers`, own)).status).toBe(400);
});
