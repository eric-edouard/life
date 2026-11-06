import { z } from "zod";
import { SourceName } from "../core/names";
import { MadeBy } from "./fields";

// Memory's communication styles (memory/communication-styles/, docs/SCHEMA.md).

/**
 * One line of a communication style: how he writes, across channels (`kind` null) or in one (`chat`, `mail`), in one
 * app when it differs there (`source`); `examples` are his own words, each found in a chat message he sent.
 */
export const CommunicationStyleLine = z
  .object({
    examples: z.array(z.string().min(1).max(200)).max(4),
    kind: z.enum(["chat", "mail"]).nullable(),
    source: SourceName.optional(),
    text: z.string().min(1).max(400),
  })
  .strict();
export type CommunicationStyleLine = z.infer<typeof CommunicationStyleLine>;

/**
 * memory/communication-styles/<id>.json: how the owner writes, in general (`me`) or to one person with a page, read from
 * his latest messages; rewritten whole when they changed and it is a week old (`inputs`, their hash; `built`).
 */
export const CommunicationStyle = z
  .object({
    built: z.string(),
    inputs: z.string(),
    lines: z.array(CommunicationStyleLine),
    madeBy: MadeBy,
    page: z.string().regex(/^person:/),
    schemaVersion: z.literal(1),
  })
  .strict();
export type CommunicationStyle = z.infer<typeof CommunicationStyle>;
