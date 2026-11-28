// What leaves the Mac here: iroh's end-to-end encrypted packets, carried through n0's public relay (`IROH_RELAY`), which
// sees the two endpoint ids, IP addresses, timing and volume, never content. To whom: n0, `aps1-1.relay.n0.iroh.link`.
// Turn it off: the connector off, or quit Life: no endpoint runs then.
import net from "node:net";
import type { Duplex } from "node:stream";
import { Endpoint, RelayMode, SecretKey } from "@number0/iroh";
import { clock } from "../../core/clock";
import { secretIn } from "../../core/secret";
import { PUBLIC_PORT } from "./http";
import { isPairedPhone, provePairing } from "./oauth";

// The phone's way to this Mac with no domain and no tunnel: one iroh endpoint that answers only the phones Life paired
// with its pairing code. Its key is the address the pairing link names, and every stream it accepts becomes one
// connection to the public port, which serves Life and voice alike.

// ponytail: one n0 relay for every install; Life runs its own iroh relay when a third party must not carry this path.
/** The one relay, read by the endpoint and by `pair --link` alike: a link never names another. */
export const IROH_RELAY = "https://aps1-1.relay.n0.iroh.link./";

/** What a connection's ALPN is compared as: the binding hands ALPNs back as bytes. */
const ALPN = (name: string) => [...new TextEncoder().encode(name)];
/** The pairing proof: one stream, the code from the QR. */
export const PAIR_ALPN = ALPN("life/pair/1");
/** The phone's HTTP, every stream piped to the public port. */
const HTTP_ALPN = ALPN("life/http/1");
/** How much of a proof stream may be the code; anything longer is not one. */
const PROOF_BYTES = 64;
/** How much of a stream is read and written at a time. */
const BATCH = 64 * 1024;
/** How long a pairing connection waits for the phone to hang up once its answer is written. */
const PHONE_HANGUP_MS = 10_000;

/**
 * The Mac's iroh secret key: 32 bytes, made once and kept with the rest of Life's secrets (`secretIn`), never sent.
 * The endpoint is the public half, so the key is only ever a file here and a seed to `secretKey`.
 */
const macKeyOf = () => [...Buffer.from(secretIn("macKey"), "hex")];

/** This Mac's address: its endpoint id and the one relay — the one place the endpoint and the pairing link read it. */
export const macAddressOf = () => ({
  mac: SecretKey.fromBytes(macKeyOf()).public().toString(),
  relay: IROH_RELAY,
});

/** A bi stream's two halves, as the pipe needs them (the binding's `BiStream` is one). */
export interface BiLike {
  recv: {
    read: (sizeLimit: number) => Promise<number[]>;
    readToEnd: (sizeLimit: number) => Promise<number[]>;
  };
  send: {
    finish: () => Promise<void>;
    writeAll: (buf: number[]) => Promise<void>;
  };
}

/** An active connection, as the accept loop reads it. */
export interface ConnLike {
  acceptBi: () => Promise<BiLike | null>;
  alpn: () => number[];
  close: (errorCode: bigint, reason: number[]) => void;
  /** The phone hung up: resolves with why it did, once it does. */
  closed: () => Promise<string>;
  remoteId: () => { toString: () => string };
}

/** An incoming connection, before its handshake. */
export interface IncomingLike {
  accept: () => Promise<{ connect: () => Promise<ConnLike> }>;
}

/** A bound endpoint, as the accept loop reads it. */
export interface EndpointLike {
  acceptNext: () => Promise<IncomingLike | null>;
}

/** What a stream answers, or `when` if it fails: a closed or reset stream is an end, never a crash. */
const or = async <T>(answering: Promise<T>, when: T) => {
  try {
    return await answering;
  } catch {
    return when;
  }
};

/**
 * One iroh bi stream piped both ways to `socket`: the socket's bytes written on as they come, in that order, one write at
 * a time (the stream takes no second writer), and its end finishing the stream; the stream's bytes written to the
 * socket, its end ending the socket.
 */
export function pipeStream(bi: BiLike, socket: Duplex) {
  let writes = Promise.resolve();
  socket.on("data", (data: Buffer) => {
    writes = writes
      .then(() => bi.send.writeAll([...data]))
      .catch(() => {
        // The stream is gone: the socket goes with it.
        socket.destroy();
      });
  });
  socket.on("end", () => {
    writes = writes.then(() => bi.send.finish()).catch(() => undefined);
  });
  // A broken socket must not take the process down; ending the stream tells the phone.
  socket.on("error", () => {
    bi.send.finish().catch(() => undefined);
  });
  (async () => {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: one chunk at a time, in the stream's order
      const chunk = await or(bi.recv.read(BATCH), []);
      if (chunk.length === 0) {
        socket.end();
        return;
      }
      if (!socket.write(new Uint8Array(chunk))) {
        await or(
          new Promise((drained) => {
            // A socket that closes or fails first never drains, so its close ends the wait too.
            socket.once("close", () => drained(undefined));
            socket.once("drain", () => drained(undefined));
          }),
          undefined
        );
      }
    }
  })().catch(() => undefined);
}

/** Whether a connection asked for `want`. */
const isAlpn = (got: number[], want: number[]) =>
  got.length === want.length && got.every((byte, i) => byte === want[i]);

/**
 * The pairing proof: the code from the phone's QR, answered `ok` only when it binds this phone's endpoint id, then
 * `refused` for anything else (a wrong or stale code, another phone, an agent's pairing).
 */
async function proveOverStream(conn: ConnLike, id: string) {
  const bi = await or<BiLike | null>(conn.acceptBi(), null);
  let bound = false;
  if (bi) {
    const code = new TextDecoder()
      .decode(new Uint8Array(await or(bi.recv.readToEnd(PROOF_BYTES), [])))
      .trim();
    try {
      bound = Boolean(code) && provePairing(code, id);
    } catch {
      // Unreadable sign-in state: no proof, so no new phone.
    }
    const answer = new TextEncoder().encode(bound ? "ok" : "refused");
    await or(bi.send.writeAll([...answer]), undefined);
    await or(bi.send.finish(), undefined);
  }
}

/** Waits for the phone to hang up, at most `PHONE_HANGUP_MS`: a phone that walks away cannot hold its connection open. */
async function waitForHangUp(conn: ConnLike) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    or(conn.closed(), "closed"),
    new Promise((done) => {
      timer = setTimeout(done, PHONE_HANGUP_MS);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * One connection: the phone proves the pairing code, or — a phone Life paired — its streams are piped to the public
 * port; every other endpoint id is closed before a byte reaches Life (`open` is the socket to that port).
 */
export async function handleConnection(
  conn: ConnLike,
  open: (port: number) => Duplex = (port) =>
    net.createConnection({ host: "127.0.0.1", port })
) {
  const id = conn.remoteId().toString();
  if (isAlpn(conn.alpn(), PAIR_ALPN)) {
    await proveOverStream(conn, id);
    // The answer is out: waiting for the phone to hang up keeps closing from dropping it.
    await waitForHangUp(conn);
    conn.close(0n, []);
    return;
  }
  if (!isPairedPhone(id, clock().getTime())) {
    conn.close(0n, []);
    return;
  }
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: the phone's streams, one after another, until it closes
    const bi = await or<BiLike | null>(conn.acceptBi(), null);
    if (!bi) {
      return;
    }
    pipeStream(bi, open(PUBLIC_PORT));
  }
}

/** One incoming connection, taken as far as its handshake: a failure there leaves the other connections alone. */
async function serve(incoming: IncomingLike) {
  const conn = await (await incoming.accept()).connect();
  await handleConnection(conn);
}

/**
 * Every incoming connection, each handled on its own as it comes; returns when the endpoint closes. A connection that
 * fails on the way in leaves the loop serving the next one.
 */
export async function acceptLoop(endpoint: EndpointLike) {
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: the endpoint's next connection, each handled as it comes
    const incoming = await endpoint.acceptNext();
    if (!incoming) {
      return;
    }
    serve(incoming).catch(() => undefined);
  }
}

/**
 * Life's iroh door: one endpoint on this Mac's key, no discovery (the phone is told the key), the one relay, both
 * ALPNs. Relays are never disabled: two ends behind a NAT meet through n0 or not at all.
 */
export async function serveOverIroh() {
  const builder = Endpoint.builder();
  // Minimal is the crypto provider alone: no discovery, no n0 default relay map — the one relay below is the only one.
  builder.applyMinimal();
  builder.relayMode(RelayMode.customFromUrls([IROH_RELAY]));
  builder.secretKey(macKeyOf());
  builder.alpns([PAIR_ALPN, HTTP_ALPN]);
  const endpoint = await builder.bind();
  console.log(`Life: iroh on ${endpoint.id().toString()} (${IROH_RELAY})`);
  acceptLoop(endpoint).catch(() => undefined);
  return endpoint;
}
