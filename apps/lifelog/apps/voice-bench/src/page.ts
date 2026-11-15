// The bench's page, for this Mac only: the report, the clips, his answers, and the one write, his
// answer to a reviewed voice (one line a turn). A development tool on loopback, never a page lifelog serves.
import { join } from "node:path";
import { clipPath } from "./clips";
import { ANSWER_KINDS, appendAnswer, type BenchAnswer } from "./truth";

const PAGE = join(import.meta.dir, "../page");
const VOICES = join(import.meta.dir, "../../server/src/voices");
const FILES: Record<string, string> = {
  "/": join(PAGE, "index.html"),
  "/cloud.js": join(VOICES, "cloud.js"),
  "/page.css": join(PAGE, "page.css"),
  "/page.js": join(PAGE, "page.js"),
  "/plotly.js": join(VOICES, "plotly-4.0.0.min.js"),
};
const CLIP = /^\/clips\/([\w-]+)\.wav$/;

export function parseAnswer(body: unknown): Omit<BenchAnswer, "at"> | null {
  const { id, kind, personId } = (body ?? {}) as Record<string, unknown>;
  const known = ANSWER_KINDS.find((k) => k === kind);
  if (typeof id !== "string" || !known) {
    return null;
  }
  if (known !== "person") {
    return { id, kind: known };
  }
  return typeof personId === "string" ? { id, kind: known, personId } : null;
}

// `rescore` rebuilds report.json after his answers, when the page asks.
export function answerTo(
  dir: string,
  answersPath: string,
  rescore: () => Promise<unknown>
) {
  const write = async (pathname: string, body: unknown) => {
    const answer = pathname === "/answers" ? parseAnswer(body) : null;
    if (answer) {
      await appendAnswer(answersPath, answer);
    } else if (pathname === "/score") {
      await rescore();
    } else {
      return new Response("not an answer", { status: 400 });
    }
    return Response.json({ ok: true });
  };
  const files: Record<string, string> = {
    ...FILES,
    "/answers.jsonl": answersPath,
    "/report.json": join(dir, "report.json"),
  };
  return async (req: Request) => {
    const { hostname, origin, pathname } = new URL(req.url);
    // Only this Mac's own page reads or writes: a name pointed at this Mac carries another host,
    // and a request from another site another origin.
    if (hostname !== "127.0.0.1") {
      return new Response("no", { status: 403 });
    }
    if (req.method === "POST" && req.headers.get("origin") === origin) {
      return write(pathname, await req.json().catch(() => null));
    }
    if (req.method !== "GET") {
      return new Response("no", { status: 405 });
    }
    const clip = CLIP.exec(pathname)?.[1];
    const path = clip ? clipPath(dir, clip) : files[pathname];
    const file = path && Bun.file(path);
    return file && (await file.exists())
      ? new Response(file, { headers: { "Cache-Control": "no-store" } })
      : new Response("not found", { status: 404 });
  };
}

export async function serve(...given: Parameters<typeof answerTo>) {
  const server = Bun.serve({
    fetch: answerTo(...given),
    hostname: "127.0.0.1",
    port: Number(process.env.VOICE_BENCH_PORT ?? 0),
  });
  console.log(`the voice bench: ${server.url}`);
  await new Promise(() => undefined);
}
