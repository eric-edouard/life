import { once } from "node:events";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import type { Incoming, RecvStream, SendStream } from "@number0/iroh";
import { SECRETS, secretIn } from "../../core/secret";
import { PUBLIC_PORT } from "./http";

// The Mac link: the iPhone app reaches this Mac by its key from anywhere, with nothing to set up. Each stream it opens
// is piped as bytes to the connector's port on loopback, where Life's tokens gate every route as for any other caller:
// the link carries requests, it grants nothing. iroh is loaded only here, at its start: a missing addon turns the link
// off, never the server.

/** The protocol the iPhone app opens its streams with; any other is refused at the handshake. */
const ALPN = [...Buffer.from("life/1")];

/**
 * The one relay the link keeps its home on (`RelayMode.customFromUrls`), so the pairing link can name it: n0's public
 * relay in Singapore. Privacy: it carries the link until the two devices reach each other directly, and sees both
 * devices' IP addresses, their endpoint ids, when and how much is sent; never content, encrypted end to end between the
 * two keys. Public discovery is off: only a phone given the Mac's id (the pairing QR) finds it. Nothing goes to it
 * before the first pairing (no key, no endpoint); off with the connector (`connector: false` in settings).
 */
const RELAY = "https://aps1-1.relay.n0.iroh.link./";

/** What the pairing link carries for the Mac link. */
export interface MacLinkAddress {
  /** The Mac's endpoint id: the public half of its key. */
  mac: string;
  relay: string;
}

/** A stream's bytes in one read at most. */
const CHUNK = 64 * 1024;
/** How often the server looks for the key the first pairing makes. */
const KEY_EVERY = 5000;

/** The Mac link's address, the Mac's key made if this is the first pairing. */
export async function macLinkAddress(): Promise<MacLinkAddress> {
  const { SecretKey } = await import("@number0/iroh");
  return {
    mac: SecretKey.fromBytes(keyBytes()).public().toString(),
    relay: RELAY,
  };
}

const keyBytes = () => [...Buffer.from(secretIn("macLinkKey"), "hex")];

/** Starts the Mac link once the Mac's key exists (the first `pair --link` makes it); it ends with the process. */
export function startMacLinkOnceKeyed() {
  const started = () => {
    if (!existsSync(SECRETS.macLinkKey)) {
      return false;
    }
    startMacLink().catch((e: Error) =>
      console.error(`Life: the Mac link is off: ${e.message}`)
    );
    return true;
  };
  if (!started()) {
    const timer = setInterval(
      () => started() && clearInterval(timer),
      KEY_EVERY
    );
  }
}

async function startMacLink() {
  const { Endpoint, presetMinimal, RelayMode } = await import("@number0/iroh");
  const builder = Endpoint.builder();
  presetMinimal(builder);
  builder.relayMode(RelayMode.customFromUrls([RELAY]));
  builder.secretKey(keyBytes());
  builder.alpns([ALPN]);
  const endpoint = await builder.bind();
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: one accept at a time; each connection runs on its own
    const incoming = await endpoint.acceptNext();
    if (!incoming) {
      return;
    }
    carryConnection(incoming).catch(() => {
      // The phone left mid-handshake or closed its connection: nothing to do.
    });
  }
}

async function carryConnection(incoming: Incoming) {
  const connection = await (await incoming.accept()).connect();
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: streams arrive one by one; each is piped on its own
    pipe(await connection.acceptBi());
  }
}

/**
 * One stream piped to `port` on loopback: the phone's bytes in, the port's answer back, each side read only as fast as
 * the other takes it. The answer's end finishes the stream; a failure on either side resets both.
 */
export async function pipe(
  { recv, send }: { recv: RecvStream; send: SendStream },
  port = PUBLIC_PORT
) {
  const socket = connect({ host: "127.0.0.1", port });
  try {
    await once(socket, "connect");
    toPort(recv, socket).catch((e: Error) => socket.destroy(e));
    for await (const chunk of socket) {
      await send.writeAll([...(chunk as Buffer)]);
    }
    await send.finish();
    // Answered: whatever the phone still sends is not read.
    await recv.stop(0n).catch(() => undefined);
  } catch {
    socket.destroy();
    await send.reset(0n).catch(() => undefined);
    await recv.stop(0n).catch(() => undefined);
  }
}

/**
 * The phone's bytes to the port, each read once the port took the last. The socket is never half-closed after them:
 * Bun's server could take that for a caller gone; it closes it after its answer (the phone asks `Connection: close`).
 */
async function toPort(recv: RecvStream, socket: Socket) {
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: one chunk at a time is the backpressure
    const chunk = await recv.read(CHUNK);
    if (chunk.length === 0) {
      return;
    }
    await new Promise<void>((resolve, reject) =>
      socket.write(Uint8Array.from(chunk), (e) => (e ? reject(e) : resolve()))
    );
  }
}
