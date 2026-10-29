import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A site's cookies from a browser he signs in to himself (`bun life bridge link`): Chrome opened on the site in a fresh
// profile of its own, with a debugging port on this Mac only; once the cookies a bridge needs are there, they're read
// (Chrome's DevTools protocol, `Storage.getCookies`) and the window and its profile are gone. macOS only.

export const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const LEADING_DOT = /^\./;

interface Cookie {
  domain: string;
  name: string;
  value: string;
}

/** One DevTools call on the browser's own target: its answer. */
function call(ws: WebSocket, method: string) {
  return new Promise<{ cookies?: Cookie[] }>((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMessage = (e: MessageEvent) => {
      const answer = JSON.parse(String(e.data)) as {
        error?: { message: string };
        id?: number;
        result?: { cookies?: Cookie[] };
      };
      if (answer.id === id) {
        ws.removeEventListener("message", onMessage);
        if (answer.error) {
          reject(new Error(answer.error.message));
        } else {
          resolve(answer.result ?? {});
        }
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method }));
  });
}

/**
 * Opens `url` in a fresh Chrome window and waits until he is signed in: until every name in `needed` is a cookie of
 * the site (10 minutes at most). Returns the site's cookies by name. The window and its profile go either way.
 */
export async function cookiesFromChrome(url: string, needed: string[]) {
  const profile = mkdtempSync(join(tmpdir(), "life-signin-"));
  const port = 9300 + Math.floor(Math.random() * 600);
  const chrome = Bun.spawn(
    [
      CHROME,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      url,
    ],
    { stderr: "ignore", stdout: "ignore" }
  );
  const site = new URL(url).hostname.split(".").slice(-2).join(".");
  try {
    let target: string | undefined;
    for (const _ of Array.from({ length: 30 })) {
      // biome-ignore lint/performance/noAwaitInLoops: once a second until Chrome answers
      target = await fetch(`http://127.0.0.1:${port}/json/version`)
        .then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>)
        .then((v) => v.webSocketDebuggerUrl)
        .catch(() => undefined);
      if (target) {
        break;
      }
      await Bun.sleep(1000);
    }
    if (!target) {
      throw new Error("Chrome didn't open");
    }
    const ws = new WebSocket(target);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    const deadline = performance.now() + 10 * 60_000;
    while (performance.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: every 2 s until he is signed in
      const { cookies = [] } = await call(ws, "Storage.getCookies");
      const mine = new Map(
        cookies
          .filter((c) => c.domain.replace(LEADING_DOT, "").endsWith(site))
          .map((c) => [c.name, c.value])
      );
      if (needed.every((n) => mine.has(n))) {
        ws.close();
        return mine;
      }
      await Bun.sleep(2000);
    }
    throw new Error("not signed in within 10 minutes");
  } finally {
    chrome.kill();
    await chrome.exited;
    rmSync(profile, { force: true, recursive: true });
  }
}

export const hasChrome = () => existsSync(CHROME);
