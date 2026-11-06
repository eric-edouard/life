import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { EMBEDDER_DIMENSIONS, EMBEDDER_URL, embedderAt } from "./embedder";

// A stand-in for llama-server's /v1/embeddings: records each input, answers vectors of `dimensions`.
const inputs: string[] = [];
let dimensions = EMBEDDER_DIMENSIONS;
const server = Bun.serve({
  fetch: async (req) => {
    const { input } = (await req.json()) as { input: string[] };
    inputs.push(...input);
    return Response.json({
      data: input.map((_, index) => ({
        embedding: new Array(dimensions).fill(0.1),
        index,
      })),
    });
  },
  port: 0,
});
afterAll(() => server.stop());

test("a long text is cut by bytes to what one of the embedder's slots holds, never inside a character", async () => {
  const [vector] = await embedderAt(server.url.href).embed(
    ["ก".repeat(6000), "a🫡".repeat(2000)],
    "passage"
  );
  expect(vector).toHaveLength(EMBEDDER_DIMENSIONS);
  for (const input of inputs.slice(-2)) {
    const bytes = new TextEncoder().encode(input).length;
    expect(bytes).toBeLessThanOrEqual(2040);
    expect(bytes).toBeGreaterThan(2036);
  }
  const last = inputs.at(-1) ?? "";
  expect(last.endsWith("a") || last.endsWith("🫡")).toBe(true);
});

test("a vector of another length is refused", async () => {
  dimensions = 1536;
  await expect(
    embedderAt(server.url.href).embed(["hello"], "query")
  ).rejects.toThrow();
  dimensions = EMBEDDER_DIMENSIONS;
});

test("the embedder's address and input limit are those Lifelog Host runs it with", async () => {
  const host = await Bun.file(
    join(
      import.meta.dir,
      "../../../lifelog/apps/mac-quiet/Sources/QuietCore/Host.swift"
    )
  ).text();
  expect(host).toContain(`embedderPort = ${new URL(EMBEDDER_URL).port}`);
  // EMBEDDED_BYTES is this, less room for BOS and EOS.
  expect(host).toContain('"--ubatch-size", "2048"');
});
