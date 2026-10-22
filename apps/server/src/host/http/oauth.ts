import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  SignJWT,
} from "jose";
import { z } from "zod";
import { clock, DAY, MIN } from "../../core/clock";
import { SECRETS, same, writeSecret } from "../../core/secret";
import { PAGES_CLIENT, OWNER_SUB as SUB } from "../../core/settings";
import { SCOPE } from "./auth";
import { HEADERS, TOKENS, text } from "./http";

// Life's own sign-in for one owner, when no other OAuth server issues its tokens (the `connector` setting has no
// `issuer`): the endpoints ChatGPT and Claude look for, under `<origin>/auth`. An app is approved by a pairing code
// shown on the Mac (`bun life pair`, the app's menu later): whoever holds the Mac approves. PKCE is required, an
// authorization code serves once, a refresh token is replaced each time it is used, and every token is for this one
// resource and owner.

const ACCESS_S = 3600;
const CODE_MS = MIN;
const PAIRING_MS = 5 * MIN;
const PAIRING_TRIES = 5;
/** How many registered apps may wait for their pairing at once. */
const PENDING = 20;
/** Where a client may be sent back: ChatGPT's and Claude's callbacks, and a desktop app's loopback. */
const REDIRECTS = [
  /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/,
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[\w-]+$/,
  /^https:\/\/claude\.(ai|com)\/api\/mcp\/auth_callback$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[\w/-]*$/,
];
/** Who may name itself by a client ID metadata document: ChatGPT and Claude. */
const DOCUMENT_HOSTS = new Set(["chatgpt.com", "claude.ai", "claude.com"]);

const Stored = z.object({
  clients: z.record(
    z.string(),
    z.object({ name: z.string(), redirects: z.array(z.string()) })
  ),
  key: z.record(z.string(), z.unknown()).optional(),
  pairing: z
    .object({ expires: z.number(), hash: z.string(), tries: z.number() })
    .optional(),
  refresh: z.record(
    z.string(),
    z.object({ client: z.string(), expires: z.number() })
  ),
});
type Stored = z.infer<typeof Stored>;

const read = (): Stored =>
  existsSync(SECRETS.oauth)
    ? Stored.parse(JSON.parse(readFileSync(SECRETS.oauth, "utf8")))
    : { clients: {}, refresh: {} };
/** Changes the state as it is on disk now (read and written with nothing awaited between), for its owner only. */
function update(change: (s: Stored) => Stored) {
  writeSecret("oauth", `${JSON.stringify(change(read()), null, 2)}\n`);
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const allowed = (uri: string) => REDIRECTS.some((r) => r.test(uri));

/** What a pairing code is made of: no 0/O or 1/I to misread. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const HTML_SPECIAL = /[&<>"]/g;

/** A new pairing code (6 letters and digits, 5 minutes, a few tries), for the owner to type on the approval page. */
export function pair(now = clock().getTime()) {
  const code = Array.from(
    { length: 6 },
    () => ALPHABET[randomInt(ALPHABET.length)]
  ).join("");
  update((s) => ({
    ...s,
    pairing: { expires: now + PAIRING_MS, hash: hash(code), tries: 0 },
  }));
  return code;
}

/** Whether `code` is the live pairing code; a right one is spent, a wrong one spends a try. */
function paired(code: string, now: number) {
  const p = read().pairing;
  if (!p || p.expires < now || p.tries >= PAIRING_TRIES) {
    return false;
  }
  const ok = same(hash(code.trim().toUpperCase()), p.hash);
  update((s) => ({
    ...s,
    pairing: ok ? undefined : { ...p, tries: p.tries + 1 },
  }));
  return ok;
}

/** The signing key, made once and kept with the rest of Life's sign-in state; loaded once per process. */
async function loadKey() {
  const kept = read().key;
  if (kept) {
    return { key: await importJWK(kept as JWK, "EdDSA"), pub: kept };
  }
  const { privateKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const kid = randomBytes(8).toString("hex");
  const priv = { ...(await exportJWK(privateKey)), alg: "EdDSA", kid };
  update((s) => ({ ...s, key: priv }));
  return { key: privateKey, pub: priv };
}
let keyed: ReturnType<typeof loadKey> | undefined;
const signingKey = () => {
  keyed ??= loadKey();
  return keyed;
};
/** The public half: what /jwks shows and what `verify` checks against. */
const publicJwk = ({ d: _, ...pub }: Record<string, unknown>) => pub as JWK;

interface Client {
  name: string;
  redirects: string[];
}
const parsed = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
/** How big a client's metadata document may be. */
const DOC_BYTES = 64 * 1024;

/**
 * A client: Life's own pages, one paired before, one registered and not paired yet (`pending`, in memory only), or
 * one that names itself by a metadata document on ChatGPT's or Claude's hosts (fetched with no redirect followed).
 */
async function clientOf(
  id: string,
  {
    fetchDoc,
    origin,
    pending,
  }: { fetchDoc: typeof fetch; origin: string; pending: Map<string, Client> }
): Promise<Client | null> {
  if (id === PAGES_CLIENT) {
    return { name: "Life", redirects: [`${origin}/check/callback`] };
  }
  const known = read().clients[id] ?? pending.get(id);
  if (known) {
    return known;
  }
  const url = URL.canParse(id) ? new URL(id) : null;
  if (!(url && url.protocol === "https:" && DOCUMENT_HOSTS.has(url.host))) {
    return null;
  }
  const res = await fetchDoc(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const body = res?.ok ? await res.text() : "";
  const doc = z
    .object({
      client_id: z.literal(id),
      client_name: z.string().max(100).default(url.host),
      redirect_uris: z.array(z.string()),
    })
    .safeParse(body && body.length <= DOC_BYTES ? parsed(body) : null);
  if (!(doc.success && doc.data.redirect_uris.every(allowed))) {
    return null;
  }
  return { name: doc.data.client_name, redirects: doc.data.redirect_uris };
}

const Authorize = z.object({
  client_id: z.string(),
  code_challenge: z.string().min(43),
  code_challenge_method: z.literal("S256"),
  redirect_uri: z.string(),
  resource: z.string(),
  response_type: z.literal("code"),
  scope: z.string().default(SCOPE),
  state: z.string().optional(),
});

/** The approval page's look, in Life's brand (its CSP takes no inline style). */
const CSS = `${TOKENS}
body{font:16px/1.55 var(--serif);max-width:30rem;margin:4rem auto;padding:0 16px;background:var(--white);color:var(--ink)}h1{font-size:36px;line-height:1.1;font-weight:600;margin:0 0 .5rem}input[name=pairing]{font:1.4rem var(--mono);letter-spacing:.2em;width:8em;padding:8px 12px;color:inherit;background:var(--surface);border:1px solid var(--rule);border-radius:var(--control-radius)}button{font:600 15px var(--serif);padding:11px 22px;border-radius:var(--control-radius);border:1px solid var(--ink);background:var(--ink);color:var(--white)}.bad::before{content:"● ";color:var(--error)}code,.host{font-family:var(--mono);font-size:.86em}`;
const page = (body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Life</title><link rel="stylesheet" href="/auth/page.css"><body>${body}</body>`,
    { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } }
  );
const escapeHtml = (s: string) =>
  s.replace(
    HTML_SPECIAL,
    (c) => ({ '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c
  );

/**
 * The issuer at `<origin>/auth` for `resource` (the connector's /mcp): its routes (`app`)
 * and the check of its own tokens' signature (`jwks`). `fetchDoc` reads client metadata documents (a test's stand-in).
 */
export function createIssuer(
  origin: string,
  resource: string,
  { fetchDoc = fetch, now = () => clock().getTime() } = {}
) {
  const issuer = `${origin}/auth`;
  /** Registered and not paired yet: kept in memory, a few at most, so no caller can fill the disk. */
  const pending = new Map<string, Client>();
  const codes = new Map<
    string,
    { challenge: string; client: string; expires: number; redirect: string }
  >();

  async function tokens(client: string) {
    const { key, pub } = await signingKey();
    const at = Math.floor(now() / 1000);
    const access = await new SignJWT({
      client_id: client,
      scope: `${SCOPE} offline_access`,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: String(pub.kid) })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject(SUB)
      .setIssuedAt(at)
      .setExpirationTime(at + ACCESS_S)
      .sign(key);
    const refresh = randomBytes(32).toString("base64url");
    update((s) => ({
      ...s,
      // Expired ones go as a new one comes.
      refresh: {
        ...Object.fromEntries(
          Object.entries(s.refresh).filter(([, r]) => r.expires >= now())
        ),
        [hash(refresh)]: { client, expires: now() + 90 * DAY },
      },
    }));
    return Response.json(
      {
        access_token: access,
        expires_in: ACCESS_S,
        refresh_token: refresh,
        scope: `${SCOPE} offline_access`,
        token_type: "Bearer",
      },
      { headers: HEADERS }
    );
  }

  const metadata = () =>
    Response.json({
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      issuer,
      registration_endpoint: `${issuer}/oauth2/register`,
      response_types_supported: ["code"],
      scopes_supported: [SCOPE, "offline_access"],
      token_endpoint: `${issuer}/oauth2/token`,
      token_endpoint_auth_methods_supported: ["none"],
    });

  async function authorize(req: Request, url: URL) {
    const form =
      req.method === "POST" ? await req.formData() : url.searchParams;
    const a = Authorize.safeParse(Object.fromEntries(form as URLSearchParams));
    if (!a.success || a.data.resource !== resource) {
      return text("This sign-in request is not one Life can answer.", 400);
    }
    const client = await clientOf(a.data.client_id, {
      fetchDoc,
      origin,
      pending,
    });
    if (!client?.redirects.includes(a.data.redirect_uri)) {
      return text("Unknown app or return address.", 400);
    }
    const pairing = String(form.get("pairing") ?? "");
    if (!(req.method === "POST" && paired(pairing, now()))) {
      const hidden = Object.entries(a.data)
        .map(
          ([k, v]) =>
            `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`
        )
        .join("");
      const back = new URL(a.data.redirect_uri).host;
      return page(
        `<h1>Connect ${escapeHtml(client.name)} to Life?</h1><p>It will read your memory, and it goes back to <span class="host">${escapeHtml(back)}</span>. Type the pairing code your Mac shows (<code>bun life pair</code>), only if you started this.</p>${req.method === "POST" ? '<p class="bad">That code did not match, or it expired.</p>' : ""}<form method="post">${hidden}<input name="pairing" autocomplete="one-time-code" autofocus> <button>Connect</button></form>`
      );
    }
    // Paired: a registered client is kept from now on.
    const registered = pending.get(a.data.client_id);
    if (registered) {
      pending.delete(a.data.client_id);
      update((s) => ({
        ...s,
        clients: { ...s.clients, [a.data.client_id]: registered },
      }));
    }
    const code = randomBytes(24).toString("base64url");
    codes.set(code, {
      challenge: a.data.code_challenge,
      client: a.data.client_id,
      expires: now() + CODE_MS,
      redirect: a.data.redirect_uri,
    });
    const back = new URL(a.data.redirect_uri);
    back.searchParams.set("code", code);
    back.searchParams.set("iss", issuer);
    if (a.data.state) {
      back.searchParams.set("state", a.data.state);
    }
    return Response.redirect(back.toString(), 302);
  }

  async function token(req: Request) {
    const f = Object.fromEntries(await req.formData()) as Partial<
      Record<string, string>
    >;
    if (f.grant_type === "authorization_code") {
      const c = codes.get(f.code ?? "");
      codes.delete(f.code ?? "");
      const challenge = createHash("sha256")
        .update(f.code_verifier ?? "")
        .digest("base64url");
      if (
        !c ||
        c.expires < now() ||
        c.client !== f.client_id ||
        c.redirect !== f.redirect_uri ||
        (f.resource && f.resource !== resource) ||
        !same(challenge, c.challenge)
      ) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return tokens(c.client);
    }
    if (f.grant_type === "refresh_token") {
      const key = hash(f.refresh_token ?? "");
      const r = read().refresh[key];
      update((s) => {
        const { [key]: _, ...rest } = s.refresh;
        return { ...s, refresh: rest };
      });
      if (!r || r.expires < now() || r.client !== f.client_id) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return tokens(r.client);
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  async function register(req: Request) {
    const m = z
      .object({
        client_name: z.string().max(100).default("An app"),
        redirect_uris: z.array(z.string()).min(1),
      })
      .safeParse(await req.json().catch(() => null));
    if (!(m.success && m.data.redirect_uris.every(allowed))) {
      return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
    }
    const id = randomBytes(16).toString("hex");
    pending.set(id, {
      name: m.data.client_name,
      redirects: m.data.redirect_uris,
    });
    // The oldest goes first past a few: registering is open to anyone, pairing is not.
    for (const old of [...pending.keys()].slice(0, -PENDING)) {
      pending.delete(old);
    }
    return Response.json(
      {
        client_id: id,
        client_name: m.data.client_name,
        redirect_uris: m.data.redirect_uris,
        token_endpoint_auth_method: "none",
      },
      { status: 201 }
    );
  }

  const app = new Hono()
    .all("/.well-known/oauth-authorization-server", metadata)
    .all("/.well-known/oauth-authorization-server/auth", metadata)
    .all(
      "/auth/page.css",
      () =>
        new Response(CSS, {
          headers: { ...HEADERS, "content-type": "text/css" },
        })
    )
    .all("/auth/jwks", async () =>
      Response.json({ keys: [publicJwk((await signingKey()).pub)] })
    )
    .all("/auth/oauth2/authorize", (c) =>
      authorize(c.req.raw, new URL(c.req.url))
    )
    .post("/auth/oauth2/token", (c) => token(c.req.raw))
    .post("/auth/oauth2/register", (c) => register(c.req.raw));

  /** Its own keys, for `ownerTokens`: no network, never unreachable. */
  const jwks = async (
    ...args: Parameters<ReturnType<typeof createLocalJWKSet>>
  ) =>
    createLocalJWKSet({ keys: [publicJwk((await signingKey()).pub)] })(...args);

  return { app, issuer, jwks, owner: SUB };
}
