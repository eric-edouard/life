import { z } from "zod";
import { Runner } from "../core/names";

// The field shapes the records share: slugs, dates, ids, importance.

export const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase-slug");

export const isoDate = z.iso.date();

export const isoDateTime = z.iso.datetime({ offset: true });

export const Importance = z.int().min(0).max(3);

export const UnitId = z.string().regex(/^unit_[0-9a-f]{12}$/);

/** 16 hex of SHA-256 over a unit's content. */
export const ContentHash = z.string().regex(/^[0-9a-f]{16}$/);

/** person:<slug>, project:<slug> or area:<slug> (design §3.2). */
export const EntityRef = z
  .string()
  .regex(/^(person|project|area):(?:inf_)?[a-z0-9-]+$/);

export const MomentId = z.string().regex(/^mom_[0-9a-f]{12}$/);

export const PersonRef = z.string().regex(/^person:(?:inf_)?[a-z0-9-]+$/);

/** Who made a model's output: engine and model (switching engines re-runs nothing), the prompt version, the run. */
export const MadeBy = z
  .object({
    engine: Runner.default("claude"),
    model: z.string(),
    prompt: z.string(),
    run: z.string(),
  })
  .strict();

export type MadeBy = z.infer<typeof MadeBy>;
