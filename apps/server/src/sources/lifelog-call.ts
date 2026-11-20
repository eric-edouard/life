import { settings } from "../core/settings";

/** lifelog's server (REST API): its address from settings, its token from the environment. */
const lifelogUrl = () => settings().lifelog?.url;

/** What keeps lifelog from being read: its address or its token missing; nothing when it is set up. */
export const lifelogMissing = () =>
  lifelogUrl() && process.env.LIFELOG_TOKEN
    ? undefined
    : "lifelog not set up (settings: lifelog, env: LIFELOG_TOKEN)";

function config() {
  const why = lifelogMissing();
  if (why) {
    throw new Error(why);
  }
  return { token: process.env.LIFELOG_TOKEN ?? "", url: lifelogUrl() ?? "" };
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
