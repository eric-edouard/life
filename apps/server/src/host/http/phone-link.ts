import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import {
  Endpoint,
  type Incoming,
  presetMinimal,
  type RecvStream,
  RelayMode,
  type SendStream,
} from "@number0/iroh";
import { LIFE_STATE_DIR } from "../../core/paths";
import { secretIn } from "../../core/secret";
import { PUBLIC_PORT } from "./http";

// The phone link: the iPhone app reaches this Mac by its key from anywhere, with nothing to set up. Each stream it opens
// is piped as bytes to the connector's port on loopback, where Life's tokens gate every route as for any other caller:
// the link carries requests, it grants nothing.

/** The protocol the iPhone app opens its streams with; any other is refused at the handshake. */
const ALPN = [...Buffer.from("life/1")];

/**
 * Privacy: n0's public iroh relays carry the link until the two devices reach each other directly. They see both
 * devices' IP addresses, their endpoint ids, when and how much is sent; never content, encrypted end to end between the
 * two keys. Public discovery is off: only a phone given the Mac's id and relay (the pairing QR) finds it. Off with the
 * connector (`connector: false` in settings).
 */
const RELAYS = RelayMode.defaultMode();

/** The running endpoint's address, for the pairing link (`bun life pair --link` runs in another process). */
const ADDRESS = join(LIFE_STATE_DIR, "phone-link.json");
export interface PhoneLinkAddress {
  /** The Mac's endpoint id: the public half of its key. */
  mac: string;
  /** The relay it keeps its home on. */
  relay: string;
}

/** A stream's bytes in one read at most. */
const CHUNK = 64 * 1024;

/** The phone link's endpoint, by the Mac's key, accepting until the process ends; its address written once online. */
export async function startPhoneLink() {
  const builder = Endpoint.builder();
  presetMinimal(builder);
  builder.relayMode(RELAYS);
  builder.secretKey([...Buffer.from(secretIn("phoneLinkKey"), "hex")]);
  builder.alpns([ALPN]);
  const endpoint = await builder.bind();
  writeAddressOnline(endpoint).catch((e: Error) =>
    console.error(`Life: the phone link has no relay: ${e.message}`)
  );
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

// ponytail: written once; a home relay that changes later is followed only at the next start.
async function writeAddressOnline(endpoint: Endpoint) {
  await endpoint.online();
  const relay = endpoint.addr().relayUrl();
  if (relay) {
    const address: PhoneLinkAddress = { mac: endpoint.id().toString(), relay };
    writeFileSync(ADDRESS, JSON.stringify(address));
  }
}

/** The address the running endpoint wrote, if it ever came online. */
export const readPhoneLinkAddress = (): PhoneLinkAddress | undefined =>
  existsSync(ADDRESS) ? JSON.parse(readFileSync(ADDRESS, "utf8")) : undefined;

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
