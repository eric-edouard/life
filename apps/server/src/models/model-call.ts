// What every model runner shares: the call it gets, the answer it gives, the tokens it spent, the JSON in its reply.
import { MIN } from "../core/clock";
import type { Engine } from "../core/names";

const FENCED = /```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/g;
export const MODEL_TIMEOUT_MS = 60 * MIN;

/**
 * The model's reply is meant to be bare JSON; tolerate a fence or a stray line around it, and a reply that corrects
 * itself with a second fenced object (the last one wins).
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("no JSON object in the model's reply");
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    const last = [...text.matchAll(FENCED)].at(-1)?.[1];
    if (last === undefined) {
      throw e;
    }
    return JSON.parse(last);
  }
}

/**
 * What a step needs (each step names its tier in `begin`): files, repos, closeness and imports fast, pages main, episodes
 * and extract deep (~/Life/docs/evals/events-2026-10-18.md). The judge is the yardstick: it has its own tier and does not
 * follow the working ones.
 */
export const TIERS = ["deep", "main", "fast", "judge"] as const;
export type Tier = (typeof TIERS)[number];

/** The engine, model and reasoning effort one run uses (claude takes one only from `LIFE_LLM`; an API engine's model is its routes, `routesOf`). */
export interface Llm {
  effort?: string;
  engine: Engine;
  model: string;
}

/** The tokens of a call (on its `model.run` line), or of a run's calls: input (cached included), cached input, output. */
export interface Tokens {
  cached: number;
  input: number;
  output: number;
}
export const NONE: Tokens = { cached: 0, input: 0, output: 0 };
export const add = (a: Tokens, b: Tokens): Tokens => ({
  cached: a.cached + b.cached,
  input: a.input + b.input,
  output: a.output + b.output,
});

/** An image as claude's stream-json input takes it (an API call builds its data URL from it). */
export const imageBlock = async (path: string) => ({
  source: {
    data: Buffer.from(await Bun.file(path).bytes()).toString("base64"),
    media_type: Bun.file(path).type,
    type: "base64",
  },
  type: "image",
});

/** One call as a runner gets it. */
/** An MCP server over stdio: the only tools a call may have (the question cases' agent gets Life's connector, reads only). */
export interface Tools {
  command: string[];
  env: Record<string, string>;
}
export interface ModelCall {
  dir: string;
  images: string[];
  input: unknown;
  llm: Llm;
  system: string;
  tools?: Tools;
}
/**
 * A runner's reply: its text, and what the log records of the call besides the time. `refusal`: it answered, but the
 * answer is not used (still logged with what it cost).
 */
export interface Answer {
  fields?: Record<string, unknown>;
  refusal?: string;
  text: string;
}
