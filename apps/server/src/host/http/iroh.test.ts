import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { PassThrough } from "node:stream";
import { SECRETS } from "../../core/secret";
import {
  acceptLoop,
  type BiLike,
  type ConnLike,
  handleConnection,
  IROH_RELAY,
  macAddressOf,
  PAIR_ALPN,
  pipeStream,
} from "./iroh";
import { pair, provePairing } from "./oauth";

// No relay and no endpoint here: the pipe and the accept loop are given stand-ins, and the key is read from Life's state.

const tick = () => new Promise((done) => setTimeout(done, 10));
const bytes = (text: string) => [...new TextEncoder().encode(text)];
const HEX_32 = /^[0-9a-f]{64}$/;

/** A bi stream that answers with `chunks` and keeps what was written to it. */
function standIn(chunks: string[] = []) {
  const queue = [...chunks];
  const sent: number[] = [];
  const state = { finished: false, read: 0 };
  const bi: BiLike = {
    recv: {
      read: (size: number) => {
        state.read = Math.max(state.read, size);
        return Promise.resolve(
          queue.length > 0 ? bytes(queue.shift() as string) : []
        );
      },
    },
    send: {
      finish: () => {
        state.finished = true;
        return Promise.resolve();
      },
      writeAll: (buf: number[]) => {
        sent.push(...buf);
        return Promise.resolve();
      },
    },
  };
  return {
    bi,
    finished: () => state.finished,
    readSize: () => state.read,
    sent: () => new TextDecoder().decode(new Uint8Array(sent)),
  };
}

test("the Mac's key is made once, read back, and the relay is the one constant", () => {
  const first = macAddressOf();
  expect(macAddressOf()).toEqual(first);
  expect(first).toEqual({
    mac: expect.stringMatching(HEX_32),
    relay: IROH_RELAY,
  });
  // A key of its own, only its owner reads it: no export carries it (host/export.ts leaves out every SECRETS file).
  expect(readFileSync(SECRETS.macKey, "utf8")).toMatch(HEX_32);
  expect(statSync(SECRETS.macKey).mode.toString(8).slice(-3)).toBe("600");
});

test("a stream carries the socket's bytes to the phone, in order, and ends when the socket does", async () => {
  const phone = standIn();
  const socket = new PassThrough();
  pipeStream(phone.bi, socket);
  socket.write("GET / HTTP/1.1\r\n");
  socket.write("host: life.example\r\n\r\n");
  socket.end();
  await tick();
  expect(phone.sent()).toBe("GET / HTTP/1.1\r\nhost: life.example\r\n\r\n");
  expect(phone.finished()).toBe(true);
});

test("what the phone sends reaches the socket, and its end ends the socket", async () => {
  const phone = standIn(["hel", "lo"]);
  const socket = new PassThrough();
  let heard = "";
  let ended = false;
  socket.on("data", (data: Buffer) => {
    heard += data.toString();
  });
  socket.on("end", () => {
    ended = true;
  });
  pipeStream(phone.bi, socket);
  await tick();
  expect(heard).toBe("hello");
  expect(ended).toBe(true);
});

test("a phone Life never paired is closed before a byte reaches the port", async () => {
  const seen = { accepted: 0, closed: 0 };
  const conn: ConnLike = {
    acceptBi: () => {
      seen.accepted += 1;
      return Promise.resolve(null);
    },
    alpn: () => bytes("life/http/1"),
    close: () => {
      seen.closed += 1;
    },
    closed: () => Promise.resolve("the phone hung up"),
    remoteId: () => ({ toString: () => "a-phone-life-never-paired" }),
  };
  await handleConnection(conn);
  expect(seen).toEqual({ accepted: 0, closed: 1 });
});

test("a phone that proved the pairing's code is piped stream by stream", async () => {
  expect(provePairing(pair(), "a-phone-that-proved")).toBe(true);
  const seen = { accepted: 0, closed: 0 };
  const conn: ConnLike = {
    acceptBi: () => {
      seen.accepted += 1;
      return Promise.resolve(null);
    },
    alpn: () => bytes("life/http/1"),
    close: () => {
      seen.closed += 1;
    },
    closed: () => Promise.resolve("the phone hung up"),
    remoteId: () => ({ toString: () => "a-phone-that-proved" }),
  };
  await handleConnection(conn);
  expect(seen).toEqual({ accepted: 1, closed: 0 });
});

/** A pairing proof's connection, answering with `code` and keeping what the Mac answers. */
function proofConn(id: string, code: string) {
  const phone = standIn([code]);
  let closed = false;
  const conn: ConnLike = {
    acceptBi: async () => phone.bi,
    alpn: () => PAIR_ALPN,
    close: () => {
      closed = true;
    },
    closed: () => Promise.resolve("the phone hung up"),
    remoteId: () => ({ toString: () => id }),
  };
  return {
    answer: phone.sent,
    closed: () => closed,
    conn,
    readSize: phone.readSize,
  };
}

test("the pairing stream reads the code and answers ok for it, refused for anything else", async () => {
  const code = pair();
  const right = proofConn("a-phone-proving", code);
  await handleConnection(right.conn);
  expect(right.answer()).toBe("ok");
  expect(right.readSize()).toBeLessThanOrEqual(64);
  expect(right.closed()).toBe(true);
  const wrong = proofConn("another-phone", "AAAAAA");
  await handleConnection(wrong.conn);
  expect(wrong.answer()).toBe("refused");
  expect(wrong.closed()).toBe(true);
});

test("a pairing answer is written before the Mac closes the connection, once the phone hangs up", async () => {
  const phone = standIn([pair()]);
  const order: string[] = [];
  const conn: ConnLike = {
    acceptBi: async () => phone.bi,
    alpn: () => PAIR_ALPN,
    close: () => order.push(`closed with ${phone.sent()} written`),
    closed: () => {
      order.push("the phone hung up");
      return Promise.resolve("hang up");
    },
    remoteId: () => ({ toString: () => "a-phone-proving" }),
  };
  await handleConnection(conn);
  expect(order).toEqual(["the phone hung up", "closed with ok written"]);
});

test("the accept loop takes each incoming connection and ends with the endpoint", async () => {
  const closed: string[] = [];
  const conn = (id: string): ConnLike => ({
    acceptBi: () => Promise.resolve(null),
    alpn: () => bytes("life/http/1"),
    close: () => closed.push(id),
    closed: () => Promise.resolve("the phone hung up"),
    remoteId: () => ({ toString: () => id }),
  });
  const incoming = (id: string) => ({
    accept: async () => ({ connect: async () => conn(id) }),
  });
  const queue = [incoming("first"), incoming("second")];
  await acceptLoop({ acceptNext: async () => queue.shift() ?? null });
  await tick();
  expect(closed).toEqual(["first", "second"]);
});
