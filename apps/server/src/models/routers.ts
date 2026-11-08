// An API engine's call: its routes, one host at a time, through the routers (OpenRouter, allmodels), streamed.
import { join } from "node:path";
import { z } from "zod";
import { MIN } from "../core/clock";
import {
  type Answer,
  add,
  extractJson,
  imageBlock,
  MODEL_TIMEOUT_MS,
  type ModelCall,
  NONE,
  type Tokens,
} from "./model-call";

/** One chunk of a router's streamed reply: the text so far comes in deltas; the host, finish and tokens on any chunk. */
const ChatChunk = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().nullish() }).nullish(),
        finish_reason: z.string().nullish(),
      })
    )
    .nullish(),
  // The host that served it, checked against his hosts.
  provider: z.string().nullish(),
  usage: z
    .object({
      completion_tokens: z.number(),
      prompt_tokens: z.number(),
      prompt_tokens_details: z.object({ cached_tokens: z.number() }).nullish(),
    })
    .nullish(),
});
interface ChatReply {
  finish?: string;
  provider?: string;
  text: string;
  usage?: z.infer<typeof ChatChunk>["usage"];
}
const NOT_ALNUM = /[^a-z0-9]/g;
const slug = (s: string) => s.toLowerCase().replaceAll(NOT_ALNUM, "");

/** The API routers, each its OpenAI-shaped endpoint and the key it takes; both take OpenRouter's `provider` field. */
export const ROUTERS = {
  allmodels: {
    key: "ALLMODELS_API_KEY",
    url: "https://api.allmodels.io/oai/chat/completions",
  },
  openrouter: {
    key: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
  },
};
export type Router = keyof typeof ROUTERS;
const isRouter = (r: string): r is Router => Object.hasOwn(ROUTERS, r);
/** Room for a day's episodes and their reasoning: every host of its tier models allows at least this (28 Oct 2026). */
export const MAX_TOKENS = 131_072;
/** A host that sends no chunk for this long has died mid-reply (a router's keepalives are not chunks). */
const STALL_MS = 5 * MIN;

/** One host to ask: its router, the model on it, the host. */
type Route = ReturnType<typeof routesOf>[number];

const ROUTED = /^([a-z]+):(.+)$/;

/**
 * An API engine's model as the routes to ask, in order: a router's hosts, `router:author/model@host[,host][=effort]`,
 * then the next router's after a space. A router left out is the engine's own; an effort left out is the run's
 * (`LIFE_LLM`'s). Throws on a router Life doesn't know.
 */
export function routesOf(spec: string, engine: string) {
  return spec
    .split(" ")
    .filter(Boolean)
    .flatMap((route) => {
      const [head = "", rest = ""] = route.split("@");
      const [list = "", effort] = rest.split("=");
      // A router is a bare word before `:`; a model id may hold a `:` of its own (`author/model:free`).
      const [, router = engine, model = head] = ROUTED.exec(head) ?? [];
      if (!(router && isRouter(router) && model)) {
        throw new Error(`no router like ${router} in ${route}`);
      }
      return list
        .split(",")
        .filter(Boolean)
        .map((host) => ({ effort, host, model, router })); // one host to ask (`deepinfra/fp8`: a host, then its variant)
    });
}

/**
 * One call through the engine's routes with his keys, at each route's effort, one host at a time, streamed, within
 * MODEL_TIMEOUT_MS. A host that may fail alone (a stall, a cut stream, a reply not JSON like a refusal, a 429, a 5xx, no
 * answer) gives way to the next: a router's own fallback acts only before output begins (29 Oct 2026: refuseless died
 * mid-reply). Any other failure (no key, no credit, another host) skips that router's hosts. Every host's tokens and
 * refusal are kept, its reply in the call's folder.
 */
export async function askRoutes(call: ModelCall): Promise<Answer> {
  const hosts = routesOf(call.llm.model, call.llm.engine);
  if (!hosts.length) {
    throw new Error(
      `an API engine's model is [router:]author/model@host[,host][=effort], not ${call.llm.model}`
    );
  }
  const pictures = await Promise.all(
    call.images.map(async (path) => {
      const { source } = await imageBlock(path);
      return {
        image_url: { url: `data:${source.media_type};base64,${source.data}` },
        type: "image_url",
      };
    })
  );
  const body = {
    max_tokens: MAX_TOKENS,
    messages: [
      { content: call.system, role: "system" },
      {
        content: [
          { text: JSON.stringify(call.input), type: "text" },
          ...pictures,
        ],
        role: "user",
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
  };
  const deadline = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  const refusals: string[] = [];
  let tokens: Tokens | undefined;
  let answer: Answer = { text: "" };
  const skipped = new Set<Router>();
  for (const route of hosts) {
    const { host, router } = route;
    const effort = route.effort ?? call.llm.effort;
    if (skipped.has(router)) {
      continue;
    }
    let isForAnother: boolean;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: a host is asked only when the one before it failed
      const reply = await askHost(
        route,
        { ...body, reasoning_effort: effort },
        deadline
      );
      await Bun.write(
        join(call.dir, `${router}-${slug(host)}.json`),
        JSON.stringify(reply)
      );
      answer = answerOf(route, reply);
      const garbled = answer.refusal ? undefined : notJson(router, answer.text);
      answer.refusal ??= garbled;
      // A stream that ends unfinished, with an error, or not JSON: another host may do better.
      isForAnother =
        [undefined, "error"].includes(reply.finish) || garbled !== undefined;
    } catch (e) {
      answer = { refusal: (e as Error).message, text: "" };
      isForAnother = (e as { isForAnother?: boolean }).isForAnother === true;
    }
    const spent = answer.fields?.tokens as Tokens | undefined;
    tokens = spent ? add(tokens ?? NONE, spent) : tokens;
    answer = { ...answer, fields: { ...answer.fields, effort, tokens } };
    if (!answer.refusal) {
      return answer;
    }
    refusals.push(`${host}: ${answer.refusal}`);
    if (!isForAnother) {
      skipped.add(router);
    }
  }
  return { ...answer, refusal: refusals.join("; ") };
}

/** The data of a server-sent event stream, one event at a time, to its end marker (comments, like keepalives, skipped). */
async function* sseData(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const part of body) {
    const lines = (rest + decoder.decode(part, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (data === "[DONE]") {
        return;
      }
      if (data) {
        yield data;
      }
    }
  }
}

/** An error another host may not have: a stall, a cut connection, a 429 or a 5xx. */
const forAnother = (message: string) =>
  Object.assign(new Error(message), { isForAnother: true });

/**
 * One host's streamed reply, put together. Throws `forAnother` on a stall, a network error, a 429 or a 5xx, anything
 * else (no key, another status, a bad chunk, the deadline) as final. It asks for no data kept (`zdr`; allmodels ignores it).
 */
async function askHost(
  { host, model, router }: Route,
  body: object,
  deadline: AbortSignal
) {
  const { key, url } = ROUTERS[router];
  const secret = process.env[key];
  if (!secret) {
    throw new Error(`${router} needs ${key}`);
  }
  const stalled = new AbortController();
  const timer = setTimeout(() => stalled.abort(), STALL_MS);
  const failure = (e: unknown) => {
    if (deadline.aborted) {
      return new Error(
        `${router}: the call's ${MODEL_TIMEOUT_MS / MIN} min ran out on ${host}`
      );
    }
    if (stalled.signal.aborted) {
      return forAnother(
        `${router}: ${host} sent nothing for ${STALL_MS / MIN} min`
      );
    }
    return e instanceof SyntaxError || e instanceof z.ZodError
      ? e
      : forAnother((e as Error).message);
  };
  try {
    const res = await fetch(url, {
      body: JSON.stringify({
        ...body,
        model,
        provider: {
          allow_fallbacks: false,
          data_collection: "deny",
          only: [host],
          order: [host],
          zdr: true,
        },
      }),
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.any([stalled.signal, deadline]),
      // Bun's 5-minute idle timer is the stall's to decide, chunk by chunk.
      timeout: false,
    }).catch((e) => {
      throw failure(e);
    });
    if (!(res.ok && res.body)) {
      const message = `${router} ${res.status}: ${(await res.text()).slice(-300)}`;
      throw res.status >= 500 || res.status === 429
        ? forAnother(message)
        : new Error(message);
    }
    const reply: ChatReply = { text: "" };
    try {
      for await (const data of sseData(res.body)) {
        timer.refresh();
        const chunk = ChatChunk.parse(JSON.parse(data));
        const [choice] = chunk.choices ?? [];
        reply.text += choice?.delta?.content ?? "";
        reply.finish = choice?.finish_reason ?? reply.finish;
        reply.provider = chunk.provider ?? reply.provider;
        reply.usage = chunk.usage ?? reply.usage;
      }
    } catch (e) {
      throw failure(e);
    }
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

/** Why a finished reply is not the JSON every call asks for, or undefined when it is. */
function notJson(router: Router, text: string) {
  try {
    extractJson(text);
  } catch (e) {
    return `${router}: not JSON (${(e as Error).message})`;
  }
}

/** A host's reply as a runner's answer: refused when a host not among the routes served it, or it stopped without text. */
function answerOf({ host, router }: Route, reply: ChatReply): Answer {
  const u = reply.usage;
  const served = reply.provider ?? "";
  const stopped =
    reply.finish === "stop" && reply.text
      ? undefined
      : `${router}: stopped (${reply.finish ?? "cut before it finished"})`;
  return {
    fields: {
      host: served,
      tokens: u && {
        cached: u.prompt_tokens_details?.cached_tokens ?? 0,
        input: u.prompt_tokens,
        output: u.completion_tokens,
      },
    },
    refusal:
      served && slug(host.split("/")[0] ?? "") === slug(served)
        ? stopped
        : `${router}: served by ${served || "an unnamed host"}, not ${host}`,
    text: reply.text,
  };
}
