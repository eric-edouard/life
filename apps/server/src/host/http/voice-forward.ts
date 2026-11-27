import type { Context } from "hono";

// The phone's one origin: Life's own answers `/voice/*` by forwarding it, as it came, to the voice server on loopback.

/** The voice server's speaker map: on the Mac only, never on Life's origin (Life serves no page). */
const MAP = /^\/voices(\/|$)/;

/**
 * Forwards a `/voice/…` request to `server` (the `lifelog` setting's address) without the prefix, its body and answer
 * streamed: the voice server's own tokens are its only auth, so nothing is added or checked here. No time limit, for
 * its long polls; 502 when it is off.
 */
export function forwardToVoice(server: string) {
  return (
    c: Context<{ Bindings: { timeout?: (req: Request, s: number) => void } }>
  ) => {
    const { pathname, search } = new URL(c.req.url);
    // The map is tested on the path as decoded (`/voice/%76oices` is the map too), the request forwarded as it came.
    if (MAP.test(c.req.path.slice("/voice".length))) {
      return c.notFound();
    }
    // No limit here: the voice server bounds its own requests (its idle limit), so the forward lasts no longer.
    c.env?.timeout?.(c.req.raw, 0);
    const path = pathname.slice("/voice".length) || "/";
    return fetch(new Request(`${server}${path}${search}`, c.req.raw), {
      decompress: false,
      redirect: "manual",
    }).catch(() => new Response("The voice server is off.", { status: 502 }));
  };
}
