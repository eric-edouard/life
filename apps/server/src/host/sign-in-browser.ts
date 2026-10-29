import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME } from "../core/platform";
import { untilAnswers } from "../core/proc";
import type { CookieStep } from "../sources/matrix";

// A sign-in browser for a bridge's cookie step (`bun life bridge link`): Chrome opened on the step's page in a fresh
// profile of its own, its DevTools port picked by Chrome (`DevToolsActivePort`, so never another browser's). He signs in
// as usual; Life reads what each field names (a cookie, a header or body of the page's own requests, local storage, the
// step's `extract_js`) and, once every required field has a value and the page reached `wait_for_url_pattern`, closes
// the window. Chrome is stopped and its profile deleted on every path, Ctrl-C and his quitting Chrome included.

export const hasChrome = () => Boolean(CHROME && existsSync(CHROME));

const LEADING_DOT = /^\./;
const WAIT_MS = 10 * 60_000;

type Field = NonNullable<CookieStep["fields"]>[number];
type Source = NonNullable<Field["sources"]>[number];

interface Request {
  body?: string;
  headers: Map<string, string>;
  url: string;
}

interface Seen {
  cookies: { domain: string; name: string; value: string }[];
  extracted: Record<string, string>;
  requests: Request[];
  storage: Record<string, string>;
}

/** A DevTools connection to one page: its calls (each refused once the page is gone), and the events it sends. */
function devtools(
  ws: WebSocket,
  on: (method: string, params: Record<string, unknown>) => void
) {
  let next = 0;
  const waiting = new Map<
    number,
    (r: { error?: { message: string }; result?: unknown }) => void
  >();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data)) as {
      error?: { message: string };
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
    };
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    } else if (m.method) {
      on(m.method, m.params ?? {});
    }
  });
  ws.addEventListener("close", () => {
    for (const settle of waiting.values()) {
      settle({ error: { message: "Chrome closed" } });
    }
    waiting.clear();
  });
  return (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Chrome closed"));
        return;
      }
      next += 1;
      waiting.set(next, (r) =>
        r.error
          ? reject(new Error(r.error.message))
          : resolve((r.result ?? {}) as Record<string, unknown>)
      );
      ws.send(JSON.stringify({ id: next, method, params }));
    });
}

const lower = (headers: unknown) =>
  new Map(
    Object.entries((headers ?? {}) as Record<string, string>).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ])
  );

const onDomain = (cookie: string, domain: string) => {
  const d = cookie.replace(LEADING_DOT, "");
  return d === domain || d.endsWith(`.${domain}`);
};

/** A field's value from one of its sources, out of what the page did so far. */
function sourceValue(s: Source, seen: Seen) {
  if (s.type === "cookie") {
    const domain = s.cookie_domain?.replace(LEADING_DOT, "");
    return seen.cookies.find(
      (c) => c.name === s.name && (!domain || onDomain(c.domain, domain))
    )?.value;
  }
  if (s.type === "local_storage") {
    return seen.storage[s.name];
  }
  if (s.type === "special") {
    return seen.extracted[s.name];
  }
  const pattern = s.request_url_regex
    ? new RegExp(s.request_url_regex)
    : undefined;
  for (const r of seen.requests.toReversed()) {
    if (pattern && !pattern.test(r.url)) {
      continue;
    }
    const value =
      s.type === "request_header"
        ? r.headers.get(s.name.toLowerCase())
        : (
            JSON.parse(r.body?.startsWith("{") ? r.body : "{}") as Record<
              string,
              string
            >
          )[s.name];
    if (value) {
      return value;
    }
  }
}

/** Opens `step.url` for him to sign in; resolves to each field's value once the required ones are there. */
export async function signInWithChrome(
  step: CookieStep
): Promise<Map<string, string>> {
  const profile = mkdtempSync(join(tmpdir(), "life-signin-"));
  const chrome = Bun.spawn(
    [
      CHROME as string,
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      step.url ?? "about:blank",
    ],
    // None of Life's secrets: only what Chrome needs to start.
    {
      env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      stderr: "ignore",
      stdout: "ignore",
    }
  );
  const cleanUp = () => {
    chrome.kill();
    rmSync(profile, { force: true, recursive: true });
  };
  const abort = () => {
    cleanUp();
    process.exit(130);
  };
  process.once("SIGINT", abort);
  try {
    return await collect(step, profile, () => chrome.exitCode !== null);
  } finally {
    process.off("SIGINT", abort);
    cleanUp();
    await chrome.exited;
  }
}

/** What the window gives, polled every 2 s until the step is satisfied, Chrome quits or 10 minutes pass. */
async function collect(step: CookieStep, profile: string, quit: () => boolean) {
  // Chrome writes the port it picked, then the browser's path, once it listens.
  const port = await untilAnswers(
    // async: a file not there yet is a try that failed, not a throw.
    async () =>
      readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0],
    "Chrome"
  );
  const page = await untilAnswers(
    () =>
      fetch(`http://127.0.0.1:${port}/json/list`)
        .then(
          (r) =>
            r.json() as Promise<
              { type: string; webSocketDebuggerUrl?: string }[]
            >
        )
        .then(
          (list) => list.find((t) => t.type === "page")?.webSocketDebuggerUrl
        ),
    "Chrome's page"
  );
  const ws = new WebSocket(page);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const requests = new Map<string, Request>();
  const extracted: Record<string, string> = {};
  let url = "";
  const send = devtools(ws, (method, p) => {
    const id = String(p.requestId ?? "");
    if (method === "Network.requestWillBeSent") {
      const r = p.request as {
        headers?: unknown;
        postData?: string;
        url: string;
      };
      requests.set(id, {
        body: r.postData,
        headers: lower(r.headers),
        url: r.url,
      });
    } else if (method === "Network.requestWillBeSentExtraInfo") {
      // The headers the browser really sent, its cookies among them.
      const r = requests.get(id) ?? { headers: new Map(), url: "" };
      requests.set(id, {
        ...r,
        headers: new Map([...r.headers, ...lower(p.headers)]),
      });
    } else if (method === "Page.frameNavigated") {
      const frame = p.frame as { parentId?: string; url: string };
      url = frame.parentId ? url : frame.url;
    }
  });
  await send("Network.enable");
  await send("Page.enable");
  if (step.extract_js) {
    // It resolves once it finds its fields: in the background, while he signs in.
    send("Runtime.evaluate", {
      awaitPromise: true,
      expression: step.extract_js,
      returnByValue: true,
    })
      .then((r) =>
        Object.assign(
          extracted,
          (r.result as { value?: Record<string, string> } | undefined)?.value ??
            {}
        )
      )
      .catch(() => undefined);
  }
  const fields = step.fields ?? [];
  const reached = step.wait_for_url_pattern
    ? new RegExp(step.wait_for_url_pattern)
    : undefined;
  const start = performance.now();
  while (performance.now() - start < WAIT_MS) {
    if (quit()) {
      throw new Error("Chrome was closed before the sign-in finished");
    }
    // biome-ignore lint/performance/noAwaitInLoops: every 2 s until he is signed in
    const { cookies = [] } = (await send("Network.getAllCookies")) as {
      cookies?: Seen["cookies"];
    };
    const storage = await send("Runtime.evaluate", {
      expression: "JSON.stringify(Object.assign({}, localStorage))",
      returnByValue: true,
    })
      .then(
        (r) =>
          JSON.parse(
            String((r.result as { value?: string } | undefined)?.value ?? "{}")
          ) as Record<string, string>
      )
      .catch(() => ({}));
    const seen = {
      cookies,
      extracted,
      requests: [...requests.values()],
      storage,
    };
    const values = new Map(
      fields.flatMap((f) => {
        const v = (f.sources ?? [])
          .map((s) => sourceValue(s, seen))
          .find(Boolean);
        return v ? [[f.id, v] as const] : [];
      })
    );
    if (
      fields.every((f) => !f.required || values.has(f.id)) &&
      (!reached || reached.test(url))
    ) {
      ws.close();
      return values;
    }
    await Bun.sleep(2000);
  }
  throw new Error("not signed in within 10 minutes");
}
