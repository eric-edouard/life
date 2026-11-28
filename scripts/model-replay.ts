// The question cases' record/replay proxy (docs/operations.md, "Measuring"): Claude Code's model requests
// (`ANTHROPIC_BASE_URL`) and the copy's reads of lifelog (`lifelog.url`) go to one each, and it answers each request
// from its recordings by the request's fingerprint, so a case asked again over the same frozen copy costs nothing and
// reads nothing live. `replay` answers only from the recordings (a miss is refused and its
// request kept beside them, to see what changed); `record` asks the provider on a miss and keeps the reply; `fresh`
// asks the provider every time and keeps the newest reply. Only replies are kept, never requests but a miss's.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readLines } from "@life/server/src/core/files";

export type ReplayMode = "fresh" | "record" | "replay";

/** One kept reply: the request's fingerprint, the upstream's status, content type and body as it came. */
interface Recording {
  body: string;
  fp: string;
  status: number;
  type: string;
}

const ANTHROPIC = "https://api.anthropic.com";
/** What Claude Code adds of its own to a message's text (the date, its folder, its reminders), outside Life's part. */
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;

/** Drops what is Claude Code's own and changes from run to run: its reminders and cache marks. */
const lifePartOf = (v: unknown): unknown => {
  if (typeof v === "string") {
    return v.replace(REMINDER, "");
  }
  if (Array.isArray(v)) {
    return v
      .map(lifePartOf)
      .filter(
        (b) =>
          !(
            b &&
            typeof b === "object" &&
            (b as { type?: string; text?: string }).type === "text" &&
            (b as { text: string }).text.trim() === ""
          )
      );
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== "cache_control")
        .map(([k, x]) => [k, lifePartOf(x)])
    );
  }
  return v;
};

/**
 * A request's fingerprint: its method, path and body. A model request's body counts only its model, messages and
 * Life's tools (`mcp__…`), without what Claude Code adds of its own (its system prompt, metadata, reminders, built-in
 * tools), so a Claude Code update alone asks nothing again.
 */
export function fingerprintOf(method: string, path: string, body: string) {
  const r = (body.startsWith("{") ? JSON.parse(body) : null) as {
    messages?: unknown;
    model?: string;
    tools?: { name?: string }[];
  } | null;
  const asked = r?.messages
    ? {
        messages: lifePartOf(r.messages),
        model: r.model,
        tools: lifePartOf(
          (r.tools ?? []).filter((t) => t.name?.startsWith("mcp__"))
        ),
      }
    : body;
  return createHash("sha256")
    .update(JSON.stringify({ asked, method, path }))
    .digest("hex");
}

/** A reply worth keeping: anything the upstream meant, never a failure it may not repeat (a 5xx, a rate limit). */
const isKept = (status: number) => status < 500 && status !== 429;

/**
 * Starts the proxy before `upstream` (the model provider by default) over the recordings at `file` (JSONL, appended).
 * `misses` lists each fingerprint replay refused.
 */
export function replayProxy(
  file: string,
  mode: ReplayMode,
  upstream = ANTHROPIC
) {
  const kept = new Map<string, Recording>();
  if (existsSync(file)) {
    for (const line of readLines(file, 0)) {
      const r = JSON.parse(line) as Recording;
      kept.set(r.fp, r);
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const misses: string[] = [];
  const asked = { provider: 0, replayed: 0 };
  const server = Bun.serve({
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      const fp = fingerprintOf(
        req.method,
        `${url.pathname}${url.search}`,
        body
      );
      const hit = mode === "fresh" ? undefined : kept.get(fp);
      if (hit) {
        asked.replayed += 1;
        return new Response(hit.body, {
          headers: { "content-type": hit.type },
          status: hit.status,
        });
      }
      if (mode === "replay") {
        misses.push(fp);
        const seen = join(dirname(file), "misses");
        mkdirSync(seen, { recursive: true });
        writeFileSync(
          join(seen, `${fp}.txt`),
          `${req.method} ${url.pathname}${url.search}\n${body}`
        );
        return Response.json(
          { error: { message: `no recording for ${fp}`, type: "replay_miss" } },
          { status: 599 }
        );
      }
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("content-length");
      headers.set("accept-encoding", "identity");
      asked.provider += 1;
      const res = await fetch(`${upstream}${url.pathname}${url.search}`, {
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        headers,
        method: req.method,
      });
      const text = await res.text();
      const type = res.headers.get("content-type") ?? "text/plain";
      if (isKept(res.status)) {
        const r: Recording = { body: text, fp, status: res.status, type };
        kept.set(fp, r);
        appendFileSync(file, `${JSON.stringify(r)}\n`);
      }
      return new Response(text, {
        headers: { "content-type": type },
        status: res.status,
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return {
    asked,
    misses,
    stop: () => server.stop(true),
    url: `http://127.0.0.1:${server.port}`,
  };
}
