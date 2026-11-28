import { expect, test } from "bun:test";
import type { RecvStream, SendStream } from "@number0/iroh";
import { pipe } from "./phone-link";

/** A phone's stream, made up: `request` read in pieces, the answer kept as written, slowly (a phone on a slow link). */
function streamOf(request: Uint8Array) {
  let at = 0;
  const answer: number[] = [];
  const ends: string[] = [];
  const recv = {
    read: (limit: number) => {
      const piece = [...request.subarray(at, at + Math.min(limit, 4096))];
      at += piece.length;
      return Promise.resolve(piece);
    },
    stop: () => Promise.resolve(),
  } as unknown as RecvStream;
  const send = {
    finish: () => Promise.resolve(ends.push("finish")),
    reset: () => Promise.resolve(ends.push("reset")),
    writeAll: async (bytes: number[]) => {
      await Bun.sleep(1);
      answer.push(...bytes);
    },
  } as unknown as SendStream;
  return { answer, ends, recv, send };
}

test("a stream carries a request whole to the port and its answer whole back, then finishes; a port that is not there resets it", async () => {
  const server = Bun.serve({
    fetch: async (req) => new Response(await req.arrayBuffer()),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const body = new Uint8Array(512 * 1024).map((_, i) => i % 251);
    const head = `POST /echo HTTP/1.0\r\nHost: life\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n`;
    const stream = streamOf(
      Buffer.concat([Buffer.from(head), Buffer.from(body)])
    );
    await pipe(stream, server.port);
    const answer = Buffer.from(stream.answer);
    const split = answer.indexOf("\r\n\r\n");
    expect(answer.subarray(0, 15).toString()).toBe("HTTP/1.1 200 OK");
    expect(answer.subarray(split + 4).equals(Buffer.from(body))).toBe(true);
    expect(stream.ends).toEqual(["finish"]);
  } finally {
    server.stop(true);
  }
  const refused = streamOf(new Uint8Array());
  await pipe(refused, server.port);
  expect(refused.ends).toEqual(["reset"]);
});
