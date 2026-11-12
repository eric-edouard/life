import { z } from "zod";
import { Engine } from "../core/names";

// The field shapes the records share: slugs, dates, ids, importance.

export const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase-slug");

export const isoDate = z.iso.date();

export const isoDateTime = z.iso.datetime({ offset: true });

export const Importance = z.int().min(0).max(3);

/** A unit id anywhere in a text (global: `text.match(UNIT_ID)` lists them). */
export const UNIT_ID = /unit_[0-9a-f]{12}/g;
export const UnitId = z.string().regex(new RegExp(`^${UNIT_ID.source}$`));

/** 16 hex of SHA-256 over a unit's content. */
export const ContentHash = z.string().regex(/^[0-9a-f]{16}$/);

/** person:<slug>, project:<slug> or area:<slug> (design §3.2). */
export const EntityRef = z
  .string()
  .regex(/^(?:person:(?:inf_|con_)?|(?:project|area):(?:inf_)?)[a-z0-9-]+$/);

export const EpisodeId = z.string().regex(/^ep_[0-9a-f]{12}$/);

export const PersonRef = z.string().regex(/^person:(?:inf_|con_)?[a-z0-9-]+$/);

/** Who made a model's output: engine and model (switching engines re-runs nothing), the prompt version, the run. */
export const MadeBy = z
  .object({
    engine: Engine.default("claude"),
    model: z.string(),
    prompt: z.string(),
    run: z.string(),
  })
  .strict();

export type MadeBy = z.infer<typeof MadeBy>;

/** The most characters a kept quote holds. */
export const QUOTE_CHARS = 200;
/** Words found verbatim in a message a model call was shown (`foundQuotes`), with that message's time. */
export const FoundQuote = z
  .object({ at: isoDateTime, text: z.string().min(1).max(QUOTE_CHARS) })
  .strict();
export type FoundQuote = z.infer<typeof FoundQuote>;
