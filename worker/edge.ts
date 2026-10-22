// Life's public edge (Cloudflare Worker on every path of life.ericedouard.com, wrangler.jsonc): every request goes to
// the Mac through Tailscale Funnel (`MAC_ORIGIN`, HTTPS on a port any network and VPN lets through, unlike the
// Cloudflare tunnel's 7844). It passes the Mac's answer as is and decides nothing; a bridge until #137.

interface Env {
  /** The Mac's Funnel origin (`tailscale funnel --https=8443 http://127.0.0.1:46200`), passed at deploy with `--var`. */
  MAC_ORIGIN: string;
}

export default {
  fetch(req: Request, env: Env) {
    const { pathname, search } = new URL(req.url);
    // The Mac answers as is: its redirects (sign-in) go back to the browser, not followed here.
    return fetch(new Request(`${env.MAC_ORIGIN}${pathname}${search}`, req), {
      redirect: "manual",
    }).catch(
      () =>
        new Response("Life's Mac is offline.", {
          headers: { "content-type": "text/plain; charset=utf-8" },
          status: 503,
        })
    );
  },
};
