import { z } from "zod";
import { SourceName } from "../core/names";
import { isoDateTime, MadeBy } from "./fields";

// Memory's personas (memory/personas/, docs/SCHEMA.md).

/** Words found verbatim in a message the persona call was shown (`locate`), with that message's time. */
export const PersonaQuote = z
  .object({ at: isoDateTime, text: z.string().min(1).max(200) })
  .strict();
export type PersonaQuote = z.infer<typeof PersonaQuote>;

const quotes = z.array(PersonaQuote).max(4);

/** A reading of the person or of what is between them and him, backed by quotes from both sides' messages. */
const ReadingLine = z
  .object({
    facet: z.enum(["traits", "wants", "reacts", "pattern", "approach"]),
    quotes,
    text: z.string().min(1).max(500),
  })
  .strict();

/**
 * How one of the two writes to the other (`writer`), across channels (`kind` null) or in one (`chat`, `mail`), in one app
 * when it differs there (`source`); its quotes are that writer's own chat messages.
 */
const WritesLine = z
  .object({
    facet: z.literal("writes"),
    kind: z.enum(["chat", "mail"]).nullable(),
    quotes,
    source: SourceName.optional(),
    text: z.string().min(1).max(400),
    writer: z.enum(["owner", "them"]),
  })
  .strict();

export const PersonaLine = z.discriminatedUnion("facet", [
  ReadingLine,
  WritesLine,
]);
export type PersonaLine = z.infer<typeof PersonaLine>;

/**
 * memory/personas/<id>.json: what someone with a page is like, what keeps happening between them and the owner, and how
 * each writes to the other (the owner's own: across everyone), read from three years of their 1:1 messages; rewritten
 * whole when its inputs changed and it is a week old (`inputs`, their hash; `built`).
 */
export const Persona = z
  .object({
    built: z.string(),
    inputs: z.string(),
    lines: z.array(PersonaLine),
    madeBy: MadeBy,
    page: z.string().regex(/^person:/),
    schemaVersion: z.literal(1),
  })
  .strict();
export type Persona = z.infer<typeof Persona>;
