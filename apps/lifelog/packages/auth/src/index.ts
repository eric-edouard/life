// OAuth 2.1 for Life (LIFE_URL), the owner's one MCP connector for ChatGPT and Claude. Better
// Auth is the authorization server; the owner is its only user and signs in on a plain HTML page.
// Its tokens' audience is Life, which checks them against this server's keys (/api/auth/jwks);
// they open nothing here. The phone never uses this: it keeps its device token.
import { oauthProvider } from "@better-auth/oauth-provider";
import type { Db } from "@lifelog/db";
import { authSchema } from "@lifelog/db/schema/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";

// What the issuer needs, from the server's settings (apps/server/src/config.ts `authSettings`).
export interface AuthSettings {
  baseUrl: string;
  lifeUrl: string | undefined;
  secret: string | undefined;
}

// Life's MCP at LIFE_URL: the audience of its tokens, and what they let it read.
export const lifeResource = (lifeUrl: string) => new URL("/mcp", lifeUrl).href;
export const LIFE_SCOPE = "life:read";

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//;
// Codes go only to ChatGPT's, Claude's and Life's own callbacks, or to this Mac (Claude Code's
// loopback): the exact ones the live clients use (Oct 21). Any other path on those hosts (a
// custom GPT's, say) is a stranger's. Checked at authorize, so it holds for every client,
// however and whenever it registered.
const trustedRedirects = (lifeUrl: string) =>
  new Set([
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://claude.ai/api/mcp/auth_callback",
    new URL("/check/callback", lifeUrl).href,
  ]);

// Who receives the code, as the consent page names it.
export const redirectHost = (uri: string) =>
  LOOPBACK.test(uri)
    ? "this Mac"
    : (URL.parse(uri)?.host ?? "an unknown address");

// Life's sign-in: on with AUTH_SECRET and LIFE_URL, since without Life its tokens open nothing.
export const authFor = ({ baseUrl, lifeUrl, secret }: AuthSettings, db: Db) =>
  secret && lifeUrl ? createAuth(baseUrl, db, secret, lifeUrl) : null;

function createAuth(baseUrl: string, db: Db, secret: string, lifeUrl: string) {
  const resource = lifeResource(lifeUrl);
  const trusted = trustedRedirects(lifeUrl);
  return betterAuth({
    basePath: "/api/auth",
    baseURL: baseUrl,
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    // The owner account is created by `bun run owner`; nobody signs up.
    emailAndPassword: { disableSignUp: true, enabled: true },
    plugins: [
      jwt(),
      oauthProvider({
        // ChatGPT and Claude register themselves (RFC 7591). Registration alone grants
        // nothing: every token still needs the owner's sign-in and consent, and a trusted callback.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Every client registered may ask for Life.
        clientRegistrationDefaultResources: [resource],
        consentPage: "/consent",
        loginPage: "/sign-in",
        // A retried refresh gets the response of the one before, as MCP clients retry.
        refreshTokenReuseInterval: 30,
        resources: [
          {
            allowedScopes: [LIFE_SCOPE, "offline_access"],
            identifier: resource,
            name: "Life",
          },
        ],
        scopes: ["offline_access", LIFE_SCOPE],
        validateRedirectUri: (uri, _registered, matched) =>
          matched && (trusted.has(uri) || LOOPBACK.test(uri)),
      }),
    ],
    secret,
  });
}

export type Auth = ReturnType<typeof createAuth>;

// Claude Code registers a loopback redirect without saying it's a native app, and Better
// Auth then refuses it as a web client. Such a client is native (RFC 8252), so say so.
export async function asNativeIfLoopback(request: Request) {
  const body = await request
    .clone()
    .json()
    .catch(() => null);
  const uris: unknown = body?.redirect_uris;
  if (
    body?.application_type ||
    !Array.isArray(uris) ||
    uris.length === 0 ||
    !uris.every((uri) => typeof uri === "string" && LOOPBACK.test(uri))
  ) {
    return request;
  }
  return new Request(request, {
    body: JSON.stringify({ ...body, application_type: "native" }),
  });
}

// The two pages the OAuth flow sends the owner to. Better Auth signs the authorize request
// into this page's query; sending it back as `oauth_query` resumes the flow after sign-in
// or consent, and the answer says where to go next.
const page = (title: string, body: string, script: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font:16px system-ui;max-width:22rem;margin:4rem auto;padding:0 1rem;color:#222}
input,button{font:inherit;width:100%;padding:.6rem;margin:.3rem 0;box-sizing:border-box}
p.error{color:#b00}</style></head>
<body><h1>${title}</h1>${body}<p class="error" id="error"></p>
<script>
const query = location.search.slice(1);
async function send(path, body) {
  const res = await fetch(path, {
    body: JSON.stringify({ ...body, oauth_query: query }),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const data = await res.json().catch(() => ({}));
  const next = data.url ?? data.redirect_uri;
  if (res.ok && next) location.href = next;
  else document.getElementById("error").textContent = data.message ?? data.error_description ?? "That didn't work.";
}
${script}
</script></body></html>`;

export const signInPage = () =>
  page(
    "lifelog",
    `<form id="form"><input name="email" type="email" autocomplete="username" placeholder="Email" required>
<input name="password" type="password" autocomplete="current-password" placeholder="Password" required>
<button>Sign in</button></form>`,
    `document.getElementById("form").onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  send("/api/auth/sign-in/email", { email: f.get("email"), password: f.get("password") });
};`
  );

const plain = (text: string) => text.replace(/[&<>"]/g, "");

// Names who connects, where the code goes, and what Life's token lets it do.
export const consentPage = (client: string, host: string) =>
  page(
    "Allow access?",
    `<p><b>${plain(client)}</b> asks to connect. Its sign-in code goes to <b>${plain(host)}</b>.</p>
<p>It will read your memory, chats, voice and places through <b>Life</b>, and change your Reminders, Atlas's tasks and your corrections to Life.</p>
<button id="allow">Allow</button><button id="deny">Deny</button>`,
    `document.getElementById("allow").onclick = () => send("/api/auth/oauth2/consent", { accept: true });
document.getElementById("deny").onclick = () => send("/api/auth/oauth2/consent", { accept: false });`
  );

// Creates the owner's account, or resets its password. The only way an account exists.
export async function setOwner(auth: Auth, email: string, password: string) {
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(password);
  const existing = await ctx.internalAdapter.findUserByEmail(email);
  if (existing) {
    await ctx.internalAdapter.updatePassword(existing.user.id, hash);
    return;
  }
  const user = await ctx.internalAdapter.createUser(
    { email, emailVerified: true, name: "Owner" },
    { method: "admin" }
  );
  await ctx.internalAdapter.linkAccount({
    accountId: user.id,
    password: hash,
    providerId: "credential",
    userId: user.id,
  });
}
