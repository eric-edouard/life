import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  SignJWT,
} from "jose";
import { z } from "zod";
import { SCOPE } from "./auth";
import { clock } from "./clock";
import { HEADERS, text } from "./http";
import { PAGES_CLIENT, OWNER_SUB as SUB } from "./settings";
import { STATE } from "./truth";

// Life's own sign-in for one owner, when no other OAuth server issues its tokens (the `connector` setting has no
// `issuer`): the endpoints ChatGPT and Claude look for, under `<origin>/auth`. An app is approved by a pairing code
// shown on the Mac (`bun life pair`, the app's menu later): whoever holds the Mac approves. PKCE is required, an
// authorization code serves once, a refresh token is replaced each time it is used, and every token is for this one
// resource and owner.

const DIR = join(STATE, "oauth");
const FILE = join(DIR, "state.json");

const ACCESS_S = 3600;
const CODE_MS = 60_000;
const PAIRING_MS = 5 * 60_000;
const PAIRING_TRIES = 5;
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
  existsSync(FILE)
    ? Stored.parse(JSON.parse(readFileSync(FILE, "utf8")))
    : { clients: {}, refresh: {} };
const write = (s: Stored) => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
  write({
    ...read(),
    pairing: { expires: now + PAIRING_MS, hash: hash(code), tries: 0 },
  });
  return code;
}

/** Whether `code` is the live pairing code; a right one is spent, a wrong one spends a try. */
function paired(code: string, now: number) {
  const s = read();
  const p = s.pairing;
  if (!p || p.expires < now || p.tries >= PAIRING_TRIES) {
    return false;
  }
  const ok = same(hash(code.trim().toUpperCase()), p.hash);
  write({ ...s, pairing: ok ? undefined : { ...p, tries: p.tries + 1 } });
  return ok;
}

/** The signing key, made once and kept with the rest of Life's sign-in state. */
async function signingKey() {
  const s = read();
  if (s.key) {
    return { key: await importJWK(s.key as JWK, "EdDSA"), pub: s.key };
  }
  const { privateKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const kid = randomBytes(8).toString("hex");
  const priv = { ...(await exportJWK(privateKey)), alg: "EdDSA", kid };
  write({ ...s, key: priv });
  return { key: privateKey, pub: priv };
}
/** The public half: what /jwks shows and what `verify` checks against. */
const publicJwk = ({ d: _, ...pub }: Record<string, unknown>) => pub as JWK;

/** A client: one Life registered, or one that names itself by a metadata document on ChatGPT's or Claude's hosts. */
async function clientOf(id: string, fetchDoc: typeof fetch, origin: string) {
  if (id === PAGES_CLIENT) {
    return { name: "Life", redirects: [`${origin}/check/callback`] };
  }
  const known = read().clients[id];
  if (known) {
    return known;
  }
  const url = URL.canParse(id) ? new URL(id) : null;
  if (!(url && url.protocol === "https:" && DOCUMENT_HOSTS.has(url.host))) {
    return null;
  }
  const res = await fetchDoc(url, { signal: AbortSignal.timeout(10_000) });
  const doc = z
    .object({
      client_id: z.literal(id),
      client_name: z.string().default(url.host),
      redirect_uris: z.array(z.string()),
    })
    .safeParse(res.ok ? await res.json() : null);
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

const page = (body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Life</title><body style="font:17px/1.5 Georgia,serif;max-width:28rem;margin:4rem auto;padding:0 1rem;background:#f7f7f5;color:#1b1d1f">${body}</body>`,
    { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } }
  );
const escapeHtml = (s: string) =>
  s.replace(
    HTML_SPECIAL,
    (c) => ({ '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c
  );

/**
 * The issuer at `<origin>/auth` for `resource` (the connector's /mcp): its routes (`handle`, null for any other path)
 * and the check of its own tokens' signature (`jwks`). `fetchDoc` reads client metadata documents (a test's stand-in).
 */
export function createIssuer(
  origin: string,
  resource: string,
  { fetchDoc = fetch, now = () => clock().getTime() } = {}
) {
  const issuer = `${origin}/auth`;
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
    const s = read();
    s.refresh[hash(refresh)] = { client, expires: now() + 90 * 86_400_000 };
    write(s);
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
    const client = await clientOf(a.data.client_id, fetchDoc, origin);
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
      return page(
        `<h1 style="font-size:1.6rem">Connect ${escapeHtml(client.name)} to Life?</h1><p>It will read your memory. Type the pairing code your Mac shows (<code>bun life pair</code>).</p>${req.method === "POST" ? "<p><b>That code did not match, or it expired.</b></p>" : ""}<form method="post">${hidden}<input name="pairing" autocomplete="one-time-code" autofocus style="font:1.4rem monospace;letter-spacing:.2em;width:8em"> <button>Connect</button></form>`
      );
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
      const s = read();
      const key = hash(f.refresh_token ?? "");
      const r = s.refresh[key];
      delete s.refresh[key];
      write(s);
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
    const s = read();
    s.clients[id] = {
      name: m.data.client_name,
      redirects: m.data.redirect_uris,
    };
    write(s);
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

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/.well-known/oauth-authorization-server":
      case "/.well-known/oauth-authorization-server/auth":
        return metadata();
      case "/auth/jwks":
        return Response.json({ keys: [publicJwk((await signingKey()).pub)] });
      case "/auth/oauth2/authorize":
        return await authorize(req, url);
      case "/auth/oauth2/token":
        return req.method === "POST" ? await token(req) : null;
      case "/auth/oauth2/register":
        return req.method === "POST" ? await register(req) : null;
      default:
        return null;
    }
  }

  /** Its own keys, for `ownerTokens`: no network, never unreachable. */
  const jwks = async (
    ...args: Parameters<ReturnType<typeof createLocalJWKSet>>
  ) =>
    createLocalJWKSet({ keys: [publicJwk((await signingKey()).pub)] })(...args);

  return { handle, issuer, jwks, owner: SUB };
}
