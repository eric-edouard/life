import { z } from "zod";
import { SourceName } from "../core/names";
import { FoundQuote, MadeBy } from "./fields";

// Memory's communication styles (memory/communication-styles/, docs/SCHEMA.md).

/**
 * One line of a communication style: how one of the two (`writer`) writes to the other, across channels (`kind` null) or
 * in one (`chat`, `mail`), in one app when it differs there (`source`); its `quotes` are that writer's own chat messages.
 */
export const CommunicationStyleLine = z
  .object({
    kind: z.enum(["chat", "mail"]).nullable(),
    quotes: z.array(FoundQuote).max(4),
    source: SourceName.optional(),
    text: z.string().min(1).max(400),
    writer: z.enum(["owner", "them"]),
  })
  .strict();
export type CommunicationStyleLine = z.infer<typeof CommunicationStyleLine>;

/**
 * memory/communication-styles/<id>.json: how the owner writes to someone with a page and how they write to him, read
 * from their newest 1:1 chat messages and mails; rewritten whole when those changed and it is a week old (`inputs`,
 * their hash; `built`). Version 1, the 6 Nov shape (his style only, `examples`), reads as none.
 */
export const CommunicationStyle = z
  .object({
    built: z.string(),
    inputs: z.string(),
    lines: z.array(CommunicationStyleLine),
    madeBy: MadeBy,
    page: z.string().regex(/^person:/),
    schemaVersion: z.literal(2),
  })
  .strict();
export type CommunicationStyle = z.infer<typeof CommunicationStyle>;
