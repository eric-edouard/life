import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_DATA } from "../core/platform";
import { settings } from "../core/settings";

/** Voice's secrets on this Mac, in one owner-only file: written by `host/voice.ts` alone, read by voice's Mac helper too. */
export const VOICE_SECRETS = join(APP_DATA, "lifelog-quiet", "secrets.json");

/** `file`'s text, none when there is none; a file group or others can access is refused. */
export function readOwnerOnly(file: string) {
  if (!existsSync(file)) {
    return;
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: a mode's bits.
  const mode = statSync(file).mode & 0o777;
  // biome-ignore lint/suspicious/noBitwiseOperators: a mode's bits.
  if (mode & 0o077) {
    throw new Error(
      `${file} is readable by others (mode ${mode.toString(8)}); run chmod 600 on it, then restart`
    );
  }
  return readFileSync(file, "utf8");
}

/** Voice's secrets as stored (`{}` without the file), refused when others can read them. */
export const readVoiceSecrets = (file = VOICE_SECRETS) =>
  JSON.parse(readOwnerOnly(file) ?? "{}") as Record<string, unknown>;

/** One secret of them, trimmed; none when absent or blank. */
export const secretOf = (secrets: Record<string, unknown>, key: string) => {
  const v = secrets[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** lifelog's server (REST API): its address from settings; its token voice's reader token, else `LIFELOG_TOKEN`. */
const lifelogUrl = () => settings().lifelog?.url;
const lifelogToken = () =>
  secretOf(readVoiceSecrets(), "readerToken") ?? process.env.LIFELOG_TOKEN;

/** What keeps lifelog from being read: its address or its token missing, or its secrets file unsafe; nothing when it is set up. */
export function lifelogMissing() {
  try {
    return lifelogUrl() && lifelogToken()
      ? undefined
      : "lifelog not set up (settings: lifelog; voice's readerToken or env LIFELOG_TOKEN)";
  } catch (e) {
    return (e as Error).message;
  }
}

function config() {
  const why = lifelogMissing();
  if (why) {
    throw new Error(why);
  }
  return { token: lifelogToken() ?? "", url: lifelogUrl() ?? "" };
}

/**
 * GET `path`, or send `body` to it (POST unless `method` says otherwise): JSON, or bytes as they are when `type` names
 * them. A refusal throws with its `status`.
 */
export async function call(
  path: string,
  timeoutS = 60,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  type = "application/json"
) {
  const { url, token } = config();
  const res = await fetch(`${url}${path}`, {
    body:
      body === undefined || body instanceof Uint8Array
        ? (body as BodyInit | undefined)
        : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": type }),
    },
    method,
    signal: AbortSignal.timeout(timeoutS * 1000),
  });
  if (!res.ok) {
    throw Object.assign(
      new Error(`lifelog ${method} ${path.split("?")[0]}: ${res.status}`),
      { status: res.status }
    );
  }
  return (await res.json()) as unknown;
}
